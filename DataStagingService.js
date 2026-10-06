/**
 * [SERVICE] DataStagingService - Sửa triệt để lỗi xóa item_name, item_code ở các kỳ khác
 */
class DataStagingService {
  constructor(tableRepo, schemaService, sysConfigService) {
    if (!tableRepo || !schemaService || !sysConfigService) {
      throw new Error("[DataStagingService] Thiếu Dependency (tableRepo, schemaService, sysConfigService).");
    }
    this.tableRepo = tableRepo;
    this.schemaService = schemaService;
    this.sysConfigService = sysConfigService;

    this.numberKeywords = ["qty", "quantity", "amount", "price", "rate", "tax", "total", "discount", "val", "cost", "vat"];
  }

  // --- Chuẩn hóa định dạng Kỳ ---
  _normalizePeriod(val) {
    if (val === null || val === undefined) return "";
    return String(val).replace(/[^0-9]/g, "").trim();
  }

  _cleanNumber(val) {
    if (val === null || val === undefined || val === "") return 0;
    if (typeof val === "number") return isNaN(val) ? 0 : val;

    let str = String(val).trim();
    if (!str) return 0;

    str = str.replace(/[^0-9\,\.\-]/g, "");

    if (str.includes(",") && str.includes(".")) {
      if (str.lastIndexOf(",") > str.lastIndexOf(".")) {
        str = str.replace(/\./g, "").replace(",", ".");
      } else {
        str = str.replace(/,/g, "");
      }
    } else if (str.includes(",")) {
      const parts = str.split(",");
      if (parts.length === 2 && parts[1].length <= 2) {
        str = str.replace(",", ".");
      } else {
        str = str.replace(/,/g, "");
      }
    }

    const num = parseFloat(str);
    return isNaN(num) ? 0 : num;
  }

  _isNumberColumn(colName) {
    if (!colName) return false;
    const lower = colName.toLowerCase();
    return this.numberKeywords.some(kw => lower.includes(kw));
  }

  _removeVietnameseTones(str) {
    if (!str) return "";
    return str
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/đ/g, "d")
      .replace(/Đ/g, "D")
      .replace(/[^a-zA-Z0-9\s]/g, "")
      .trim();
  }

  _parseWildcardToRegExps(rawKwStr) {
    if (!rawKwStr) return [];
    return String(rawKwStr)
      .split(",")
      .map(pattern => {
        let trimmed = pattern.trim();
        if (!trimmed) return null;
        let escaped = trimmed.replace(/[\-\[\]\/\{\}\(\)\+\?\.\\\^\$\|]/g, "\\$&").replace(/\*+/g, ".*");
        try { return new RegExp(`^${escaped}$`, "i"); } catch (e) { return null; }
      })
      .filter(regex => regex !== null);
  }

  _getColIndex(schemaName, colKey) {
    const col1Based = this.schemaService.getColIndex(schemaName, colKey);
    return col1Based > 0 ? col1Based - 1 : -1;
  }

  /**
   * Pipeline chính
   */
  runStaging(sourceGroup, filters = null) {
    const t0 = Date.now();
    Logger.log(`[STAGING] Bắt đầu xử lý Nguồn: ${sourceGroup}`);

    let periodList = null;
    if (filters && filters.key === "period" && Array.isArray(filters.values)) {
      periodList = filters.values.map(p => this._normalizePeriod(p));
    } else if (Array.isArray(filters)) {
      periodList = filters.map(p => this._normalizePeriod(p));
    } else if (typeof filters === "string" || typeof filters === "number") {
      periodList = [this._normalizePeriod(filters)];
    }

    // 1. Chuyển RAW -> STG
    const transformedCount = this.transformRawToStaging(sourceGroup, periodList);
    
    // 2. KHÔI PHỤC: Khởi tạo trước các cặp (source_grp, raw_name) vào MAP_RULE
    this.bootstrapMapRules(sourceGroup, periodList);

    // 3. Gợi ý ánh xạ MAP_RULE dựa trên AUTO_MAP_RULE
    this.applyAutoMapNamesToMapRules(sourceGroup, periodList);

    // 4. Tạo mã item_code & Đồng bộ ITEM_MASTER
    this.generateAndSyncItemCodes();

    // 5. Cập nhật item_code/item_name vào STG
    const updatedCount = this.updateStagingMappedFields(sourceGroup, periodList);

    // 6. Quy đổi đơn vị & SKU
    this.bootstrapUnitConversionFromStaging();
    this.applyAutoSkuRules();

    if (typeof SpreadsheetApp !== "undefined" && SpreadsheetApp.flush) {
      SpreadsheetApp.flush();
    }

    Logger.log(`[STAGING] Hoàn tất ${transformedCount} bản ghi trong: ${Date.now() - t0} ms.`);

    return {
      transformedCount: transformedCount,
      updatedCount: updatedCount
    };
  }

  transformRawToStaging(sourceGroup, periodList = null, overridePrimaryKeys = null) {
    const srcMeta = this.sysConfigService.getSourceMetadata(sourceGroup);
    if (!srcMeta) throw new Error(`[transformRawToStaging] Không tìm thấy metadata cho nguồn: ${sourceGroup}`);

    const rawSchemaName = srcMeta.rawSchema;
    const stgSchemaName = srcMeta.stgSchema;
    const primaryKeys   = overridePrimaryKeys || srcMeta.primaryKeys || ["period", "line_id"];

    const rawDataInfo = this.tableRepo.getDataByTableName(rawSchemaName);
    if (!rawDataInfo || !rawDataInfo.values || rawDataInfo.values.length <= 1) return 0;

    const rawRows = rawDataInfo.values.slice(1);
    const schemaMap = this.schemaService.getSchemaMap();
    const stgColsConfig = schemaMap[stgSchemaName] ? schemaMap[stgSchemaName].columns : {};

    const rawPeriodIdx = this._getColIndex(rawSchemaName, "period");
    const rawNameIdx   = this._getColIndex(rawSchemaName, "raw_name");

    const stgCols = Object.keys(stgColsConfig);
    const totalStgCols = Math.max(...Object.values(stgColsConfig), stgCols.length);

    const colMappingPairs = [];
    for (let i = 0; i < stgCols.length; i++) {
      const colName = stgCols[i];
      const targetColIdx = stgColsConfig[colName] - 1;
      if (targetColIdx < 0) continue;

      let srcColIdx = -1;
      if (srcMeta.mapping && srcMeta.mapping[colName] !== undefined) {
        srcColIdx = this._getColIndex(rawSchemaName, srcMeta.mapping[colName]);
      } else {
        srcColIdx = this._getColIndex(rawSchemaName, colName);
      }

      colMappingPairs.push({
        colName: colName,
        targetColIdx: targetColIdx,
        srcColIdx: srcColIdx,
        isNumber: this._isNumberColumn(colName)
      });
    }

    const stgRowsToUpsert = [];
    const newRawNamesSet = new Set();
    
    const periodSet = (Array.isArray(periodList) && periodList.length > 0) 
      ? new Set(periodList.map(p => this._normalizePeriod(p))) 
      : null;

    for (let i = 0; i < rawRows.length; i++) {
      const row = rawRows[i];

      if (periodSet && rawPeriodIdx !== -1) {
        const periodVal = this._normalizePeriod(row[rawPeriodIdx]);
        if (!periodSet.has(periodVal)) continue; 
      }

      if (rawNameIdx !== -1) {
        const rawNameVal = String(row[rawNameIdx] || "").trim();
        if (rawNameVal) newRawNamesSet.add(rawNameVal);
      }

      const newStgRow = new Array(totalStgCols).fill("");

      for (let j = 0; j < colMappingPairs.length; j++) {
        const pair = colMappingPairs[j];
        if (pair.srcColIdx !== -1) {
          const rawVal = row[pair.srcColIdx];
          if (pair.isNumber) {
            newStgRow[pair.targetColIdx] = this._cleanNumber(rawVal);
          } else {
            newStgRow[pair.targetColIdx] = rawVal !== undefined && rawVal !== null ? rawVal : "";
          }
        }
      }
      stgRowsToUpsert.push(newStgRow);
    }

    if (stgRowsToUpsert.length > 0) {
      this.tableRepo.upsertRowsByTableName(stgSchemaName, stgRowsToUpsert, primaryKeys);
    }

    return stgRowsToUpsert.length;
  }

  /**
   * Áp dụng quy tắc Map - Đã sửa lỗi quét full RAW làm mất dữ liệu kỳ khác
   */
  applyAutoMapNamesToMapRules(sourceGroup, periodList = null) {
    const srcMeta = this.sysConfigService.getSourceMetadata(sourceGroup) || {};
    const targetGrp = (srcMeta.mapRuleGroup || srcMeta.coreGroup || sourceGroup).toUpperCase();
    const rawSchemaName = srcMeta.rawSchema;

    const mapRuleInfo = this.tableRepo.getDataByTableName("MAP_RULE");
    const autoMapInfo = this.tableRepo.getDataByTableName("AUTO_MAP_RULE");

    if (!mapRuleInfo || !mapRuleInfo.values || mapRuleInfo.values.length <= 1) return 0;
    if (!autoMapInfo || !autoMapInfo.values || autoMapInfo.values.length <= 1) return 0;

    const idxMR = {
      sourceGrp: this._getColIndex("MAP_RULE", "source_grp"),
      rawName:   this._getColIndex("MAP_RULE", "raw_name"),
      itemName:  this._getColIndex("MAP_RULE", "item_name")
    };

    let kwIdx = this._getColIndex("AUTO_MAP_RULE", "keywords");
    if (kwIdx === -1) kwIdx = this._getColIndex("AUTO_MAP_RULE", "keyword");

    let prioIdx = this._getColIndex("AUTO_MAP_RULE", "priority");
    if (prioIdx === -1) prioIdx = this._getColIndex("AUTO_MAP_RULE", "periority");

    const idxAM = {
      sourceGrp: this._getColIndex("AUTO_MAP_RULE", "source_grp"),
      keyword:   kwIdx,
      itemName:  this._getColIndex("AUTO_MAP_RULE", "target_item_name"),
      priority:  prioIdx
    };

    const autoRules = [];
    const amRows = autoMapInfo.values.slice(1);
    for (let i = 0; i < amRows.length; i++) {
      const r = amRows[i];
      autoRules.push({
        sourceGrp: idxAM.sourceGrp !== -1 ? String(r[idxAM.sourceGrp] || "").trim().toUpperCase() : "",
        regExps:   idxAM.keyword !== -1   ? this._parseWildcardToRegExps(String(r[idxAM.keyword] || "")) : [],
        itemName:  idxAM.itemName !== -1  ? String(r[idxAM.itemName] || "").trim() : "",
        priority:  idxAM.priority !== -1  ? Number(r[idxAM.priority] || 9999) : 9999
      });
    }
    autoRules.sort((a, b) => a.priority - b.priority);

    const rawDataInfo = this.tableRepo.getDataByTableName(rawSchemaName);
    const activeRawNamesInSource = new Set();

    if (rawDataInfo && rawDataInfo.values && rawDataInfo.values.length > 1) {
      const idxRawName = this._getColIndex(rawSchemaName, "raw_name");
      const idxRawPeriod = this._getColIndex(rawSchemaName, "period");

      const periodSet = (Array.isArray(periodList) && periodList.length > 0) 
        ? new Set(periodList.map(p => this._normalizePeriod(p))) 
        : null;

      if (idxRawName !== -1) {
        const rRows = rawDataInfo.values.slice(1);
        for (let i = 0; i < rRows.length; i++) {
          // BỔ SUNG LỌC THEO KỲ TẠI ĐÂY
          if (periodSet && idxRawPeriod !== -1) {
            const periodVal = this._normalizePeriod(rRows[i][idxRawPeriod]);
            if (!periodSet.has(periodVal)) continue; 
          }

          const rawName = String(rRows[i][idxRawName] || "").trim().toLowerCase();
          if (rawName) activeRawNamesInSource.add(rawName);
        }
      }
    }

    const mapRows = mapRuleInfo.values.slice(1);
    const modifiedRows = [];
    let updatedCount = 0;

    for (let i = 0; i < mapRows.length; i++) {
      const row = mapRows[i];
      const rowSourceGrp = String(row[idxMR.sourceGrp] || "").trim().toUpperCase();
      if (targetGrp && rowSourceGrp !== targetGrp) continue;

      const rawName = String(row[idxMR.rawName] || "").trim();
      const rawNameLower = rawName.toLowerCase();
      let currentItemName = String(row[idxMR.itemName] || "").trim();

      // Nếu có bộ lọc Kỳ, chỉ kiểm tra các rawName có mặt trong kỳ đó
      if (activeRawNamesInSource.size > 0 && !activeRawNamesInSource.has(rawNameLower)) {
        continue;
      }

      const matchedRule = autoRules.find(rule => {
        const matchGrp = (!rule.sourceGrp || rule.sourceGrp === "ALL" || rule.sourceGrp === rowSourceGrp);
        if (!matchGrp) return false;
        return rule.regExps.length > 0 && rule.regExps.some(rx => rx.test(rawName));
      });

      if (matchedRule) {
        if (currentItemName !== matchedRule.itemName) {
          row[idxMR.itemName] = matchedRule.itemName;
          updatedCount++;
          modifiedRows.push(row);
        }
      } else if (!currentItemName) {
        row[idxMR.itemName] = rawName;
        updatedCount++;
        modifiedRows.push(row);
      }
    }

    if (modifiedRows.length > 0) {
      this.tableRepo.upsertRowsByTableName("MAP_RULE", modifiedRows, ["source_grp", "raw_name"]);
    }

    return updatedCount;
  }

  generateAndSyncItemCodes() {
    const itemMasterInfo = this.tableRepo.getDataByTableName("ITEM_MASTER");
    const mapRuleInfo    = this.tableRepo.getDataByTableName("MAP_RULE");

    if (!mapRuleInfo || !mapRuleInfo.values || mapRuleInfo.values.length <= 1) return 0;

    const schemaMap = this.schemaService.getSchemaMap();
    const imColsConfig = schemaMap["ITEM_MASTER"] ? schemaMap["ITEM_MASTER"].columns : {};
    const totalIMCols = Math.max(...Object.values(imColsConfig), 8);

    const idxIM = {
      itemCode:  this._getColIndex("ITEM_MASTER", "item_code"),
      sourceGrp: this._getColIndex("ITEM_MASTER", "source_grp"),
      itemName:  this._getColIndex("ITEM_MASTER", "item_name"),
      status:    this._getColIndex("ITEM_MASTER", "status")
    };

    const idxMR = {
      sourceGrp: this._getColIndex("MAP_RULE", "source_grp"),
      rawName:   this._getColIndex("MAP_RULE", "raw_name"),
      itemName:  this._getColIndex("MAP_RULE", "item_name"),
      itemCode:  this._getColIndex("MAP_RULE", "item_code")
    };

    const existingIMMap = new Map();
    const itemRows = itemMasterInfo && itemMasterInfo.values ? itemMasterInfo.values.slice(1) : [];

    for (let i = 0; i < itemRows.length; i++) {
      const code = String(itemRows[i][idxIM.itemCode] || "").trim();
      if (code) {
        const fullRow = [...itemRows[i]];
        while (fullRow.length < totalIMCols) fullRow.push("");
        existingIMMap.set(code, fullRow);
      }
    }

    const mapRows = mapRuleInfo.values.slice(1);
    const newMasterRowsMap = new Map();
    const activeCodeSet = new Set();
    const modifiedMapRows = [];
    let generatedCount = 0;

    const generatedBaseCodesDict = new Map();

    for (let i = 0; i < mapRows.length; i++) {
      const row = mapRows[i];
      const sourceGrp = String(row[idxMR.sourceGrp] || "INT").trim().toUpperCase();
      const itemName  = String(row[idxMR.itemName] || "").trim();

      if (!itemName) continue;

      const cleanNameNoTone = this._removeVietnameseTones(itemName)
        .replace(/[^a-zA-Z0-9\s_]/g, "")
        .trim()
        .replace(/\s+/g, "_")
        .toUpperCase();
      
      const baseCode = `${sourceGrp}_${cleanNameNoTone}`;
      const itemNameLower = itemName.toLowerCase().trim();

      if (!generatedBaseCodesDict.has(baseCode)) {
        generatedBaseCodesDict.set(baseCode, new Map());
      }
      const itemNamesUnderBaseCode = generatedBaseCodesDict.get(baseCode);

      let correctCode = "";
      if (itemNamesUnderBaseCode.has(itemNameLower)) {
        correctCode = itemNamesUnderBaseCode.get(itemNameLower);
      } else {
        const currentCount = itemNamesUnderBaseCode.size;
        correctCode = currentCount === 0 ? baseCode : `${baseCode}_${currentCount}`;
        itemNamesUnderBaseCode.set(itemNameLower, correctCode);
      }

      activeCodeSet.add(correctCode);

      if (row[idxMR.itemCode] !== correctCode) {
        row[idxMR.itemCode] = correctCode;
        modifiedMapRows.push(row);
        generatedCount++;
      }

      let masterRow = existingIMMap.has(correctCode)
        ? [...existingIMMap.get(correctCode)]
        : new Array(totalIMCols).fill("");

      if (idxIM.itemCode  !== -1) masterRow[idxIM.itemCode]  = correctCode;
      if (idxIM.sourceGrp !== -1) masterRow[idxIM.sourceGrp] = sourceGrp;
      if (idxIM.itemName  !== -1) masterRow[idxIM.itemName]  = itemName;
      if (idxIM.status    !== -1) masterRow[idxIM.status]    = "ACTIVE";

      newMasterRowsMap.set(correctCode, masterRow);
    }

    if (modifiedMapRows.length > 0) {
      this.tableRepo.upsertRowsByTableName("MAP_RULE", modifiedMapRows, ["source_grp", "raw_name"]);
    }

    if (newMasterRowsMap.size > 0) {
      this.tableRepo.upsertRowsByTableName("ITEM_MASTER", Array.from(newMasterRowsMap.values()), ["item_code"]);
    }

    return generatedCount;
  }

  updateStagingMappedFields(sourceGroup, periodList = null) {
    const srcMeta = this.sysConfigService.getSourceMetadata(sourceGroup);
    if (!srcMeta) return 0;

    const stgSchemaName = srcMeta.stgSchema;
    const targetGrp = (srcMeta.mapRuleGroup || srcMeta.coreGroup || sourceGroup).toUpperCase();

    const stgDataInfo = this.tableRepo.getDataByTableName(stgSchemaName);
    const mapRuleInfo = this.tableRepo.getDataByTableName("MAP_RULE");

    if (!stgDataInfo || !stgDataInfo.values || stgDataInfo.values.length <= 1) return 0;
    if (!mapRuleInfo || !mapRuleInfo.values || mapRuleInfo.values.length <= 1) return 0;

    const idxSTG = {
      period:   this._getColIndex(stgSchemaName, "period"),
      rawName:  this._getColIndex(stgSchemaName, "raw_name"),
      itemName: this._getColIndex(stgSchemaName, "item_name"),
      itemCode: this._getColIndex(stgSchemaName, "item_code")
    };

    const idxMR = {
      sourceGrp: this._getColIndex("MAP_RULE", "source_grp"),
      rawName:   this._getColIndex("MAP_RULE", "raw_name"),
      itemName:  this._getColIndex("MAP_RULE", "item_name"),
      itemCode:  this._getColIndex("MAP_RULE", "item_code")
    };

    const mapDict = new Map();
    const mrRows = mapRuleInfo.values.slice(1);
    for (let i = 0; i < mrRows.length; i++) {
      const r = mrRows[i];
      const grp = String(r[idxMR.sourceGrp] || "").trim().toUpperCase();
      const raw = String(r[idxMR.rawName] || "").trim().toLowerCase();
      if ((grp === targetGrp || grp === "ALL") && raw) {
        mapDict.set(raw, {
          itemName: String(r[idxMR.itemName] || "").trim(),
          itemCode: String(r[idxMR.itemCode] || "").trim()
        });
      }
    }

    const targetPeriods = (Array.isArray(periodList) && periodList.length > 0)
      ? new Set(periodList.map(v => this._normalizePeriod(v)))
      : null;

    const stgRows = stgDataInfo.values.slice(1);
    let updatedCount = 0;
    const modifiedStgRows = [];

    for (let i = 0; i < stgRows.length; i++) {
      const row = stgRows[i];

      // BỎ QUA CÁC KỲ KHÔNG ĐƯỢC CHỌN (VD: KỲ 202609)
      if (targetPeriods && idxSTG.period !== -1) {
        const periodVal = this._normalizePeriod(row[idxSTG.period]);
        if (!targetPeriods.has(periodVal)) continue;
      }

      const rawName = String(row[idxSTG.rawName] || "").trim().toLowerCase();
      if (rawName && mapDict.has(rawName)) {
        const mapped = mapDict.get(rawName);
        const currentName = idxSTG.itemName !== -1 ? String(row[idxSTG.itemName] || "").trim() : "";
        const currentCode = idxSTG.itemCode !== -1 ? String(row[idxSTG.itemCode] || "").trim() : "";

        if (currentName !== mapped.itemName || currentCode !== mapped.itemCode) {
          const updatedRow = [...row];
          if (idxSTG.itemName !== -1) updatedRow[idxSTG.itemName] = mapped.itemName;
          if (idxSTG.itemCode !== -1) updatedRow[idxSTG.itemCode] = mapped.itemCode;
          modifiedStgRows.push(updatedRow);
          updatedCount++;
        }
      }
    }

    if (modifiedStgRows.length > 0) {
      this.tableRepo.upsertRowsByTableName(stgSchemaName, modifiedStgRows, srcMeta.primaryKeys);
    }

    return updatedCount;
  }

  bootstrapUnitConversionFromStaging() {
    const mapRuleInfo = this.tableRepo.getDataByTableName("MAP_RULE");
    const activeItemCodes = new Set();
    if (mapRuleInfo && mapRuleInfo.values && mapRuleInfo.values.length > 1) {
      const idxMRCode = this._getColIndex("MAP_RULE", "item_code");
      if (idxMRCode !== -1) {
        const mrRows = mapRuleInfo.values.slice(1);
        for (let i = 0; i < mrRows.length; i++) {
          const code = String(mrRows[i][idxMRCode] || "").trim();
          if (code) activeItemCodes.add(code);
        }
      }
    }

    const imDict = this._buildItemMasterDict();
    const ucInfo = this.tableRepo.getDataByTableName("UNIT_CONVERSION");
    const ucRows = ucInfo ? ucInfo.values : [];

    const grpIdx    = this._getColIndex("UNIT_CONVERSION", "source_grp");
    const codeIdx   = this._getColIndex("UNIT_CONVERSION", "item_code");
    const altIdx    = this._getColIndex("UNIT_CONVERSION", "alt_unit");
    const rawKwIdx  = this._getColIndex("UNIT_CONVERSION", "raw_keyword");
    const baseIdx   = this._getColIndex("UNIT_CONVERSION", "base_unit");
    const factorIdx = this._getColIndex("UNIT_CONVERSION", "conversion_factor");
    const statusIdx = this._getColIndex("UNIT_CONVERSION", "status");

    if (grpIdx === -1 || codeIdx === -1 || altIdx === -1) return 0;

    const schemaMap = this.schemaService.getSchemaMap();
    const ucColsConfig = schemaMap["UNIT_CONVERSION"] ? schemaMap["UNIT_CONVERSION"].columns : {};
    const totalCols = Math.max(...Object.values(ucColsConfig), 7);

    const existingMap = new Map();
    const rowsToUpsert = [];

    if (ucRows && ucRows.length > 1) {
      for (let i = 1; i < ucRows.length; i++) {
        const g = String(ucRows[i][grpIdx] || "INT").trim().toUpperCase();
        const c = String(ucRows[i][codeIdx] || "").trim();
        const u = String(ucRows[i][altIdx] || "").trim().toLowerCase();

        if (c && u) {
          const fullRow = [...ucRows[i]];
          while (fullRow.length < totalCols) fullRow.push("");
          existingMap.set(`${g}___${c}___${u}`, fullRow);
        }
      }
    }

    const stgTables = [
      { name: "STG_PO_INVOICE", grp: "INT" },
      { name: "STG_SO_INVOICE", grp: "OUT" }
    ];

    for (let tIdx = 0; tIdx < stgTables.length; tIdx++) {
      const t = stgTables[tIdx];
      const stgInfo = this.tableRepo.getDataByTableName(t.name);
      const rows = stgInfo ? stgInfo.values : [];
      if (!rows || rows.length <= 1) continue;

      const codeStgIdx = this._getColIndex(t.name, "item_code");
      const unitStgIdx = this._getColIndex(t.name, "unit");

      if (codeStgIdx === -1 || unitStgIdx === -1) continue;

      for (let i = 1; i < rows.length; i++) {
        const itemCode = String(rows[i][codeStgIdx] || "").trim();
        const stgUnit  = String(rows[i][unitStgIdx] || "").trim().toLowerCase();
        if (!itemCode || !stgUnit) continue;

        const imData   = imDict[itemCode] || {};
        const baseUnit = String(imData.baseUnit || "").trim().toLowerCase();

        if (baseUnit && stgUnit !== baseUnit) {
          const key = `${t.grp}___${itemCode}___${stgUnit}`;

          if (!existingMap.has(key)) {
            const newRow = new Array(totalCols).fill("");
            newRow[grpIdx] = t.grp;
            newRow[codeIdx] = itemCode;
            newRow[altIdx] = stgUnit;
            if (rawKwIdx !== -1)  newRow[rawKwIdx] = stgUnit;
            if (baseIdx !== -1)   newRow[baseIdx] = baseUnit;
            if (factorIdx !== -1) newRow[factorIdx] = "";
            if (statusIdx !== -1) {
              newRow[statusIdx] = activeItemCodes.has(itemCode) ? "ACTIVE" : "NEED_REVIEW";
            }

            existingMap.set(key, newRow);
            rowsToUpsert.push(newRow);
          }
        }
      }
    }

    if (rowsToUpsert.length > 0) {
      this.tableRepo.upsertRowsByTableName("UNIT_CONVERSION", rowsToUpsert, ["source_grp", "item_code", "alt_unit"]);
    }

    return rowsToUpsert.length;
  }

  applyAutoSkuRules(overwriteExisting = false) {
    const imInfo = this.tableRepo.getDataByTableName("ITEM_MASTER");
    const autoSkuInfo = this.tableRepo.getDataByTableName("AUTO_SKU_RULE");

    if (!imInfo || !imInfo.values || imInfo.values.length <= 1) return 0;
    if (!autoSkuInfo || !autoSkuInfo.values || autoSkuInfo.values.length <= 1) return 0;

    const rawNonInvConfig = this.sysConfigService.getConfig("NON_INVENTORY_ITEM_TYPES") || [];
    const nonInventoryTypes = (Array.isArray(rawNonInvConfig) ? rawNonInvConfig : String(rawNonInvConfig).split(","))
      .map(t => String(t).trim().toUpperCase())
      .filter(t => t.length > 0);

    const idxIM = {
      grp:  this._getColIndex("ITEM_MASTER", "source_grp"),
      code: this._getColIndex("ITEM_MASTER", "item_code"),
      name: this._getColIndex("ITEM_MASTER", "item_name"),
      type: this._getColIndex("ITEM_MASTER", "item_type"),
      sku:  this._getColIndex("ITEM_MASTER", "inventory_sku")
    };

    let kwIdx = this._getColIndex("AUTO_SKU_RULE", "keywords");
    if (kwIdx === -1) kwIdx = this._getColIndex("AUTO_SKU_RULE", "keyword");

    let targetSkuIdx = this._getColIndex("AUTO_SKU_RULE", "target_sku");
    if (targetSkuIdx === -1) targetSkuIdx = this._getColIndex("AUTO_SKU_RULE", "inventory_sku");

    let prioIdx = this._getColIndex("AUTO_SKU_RULE", "priority");
    if (prioIdx === -1) prioIdx = this._getColIndex("AUTO_SKU_RULE", "periority");

    const idxAS = {
      sourceGrp: this._getColIndex("AUTO_SKU_RULE", "source_grp"),
      keyword:   kwIdx,
      targetSku: targetSkuIdx,
      priority:  prioIdx
    };

    const autoRules = autoSkuInfo.values.slice(1)
      .map(r => ({
        sourceGrp: idxAS.sourceGrp !== -1 ? String(r[idxAS.sourceGrp] || "").trim().toUpperCase() : "",
        regExps:   idxAS.keyword !== -1 ? this._parseWildcardToRegExps(String(r[idxAS.keyword] || "")) : [],
        targetSku: idxAS.targetSku !== -1 ? String(r[idxAS.targetSku] || "").trim() : "",
        priority:  idxAS.priority !== -1 ? Number(r[idxAS.priority] || 9999) : 9999
      }))
      .filter(r => r.regExps.length > 0 && r.targetSku)
      .sort((a, b) => a.priority - b.priority);

    const imRows = imInfo.values.slice(1);
    const modifiedImRows = [];
    let updatedCount = 0;

    for (let i = 0; i < imRows.length; i++) {
      const row = imRows[i];
      const imGrp = idxIM.grp !== -1 ? String(row[idxIM.grp] || "").trim().toUpperCase() : "";
      const imCode = String(row[idxIM.code] || "").trim();
      const itemName = String(row[idxIM.name] || "").trim();
      const itemType = idxIM.type !== -1 ? String(row[idxIM.type] || "").trim().toUpperCase() : "";
      let currentSku = String(row[idxIM.sku] || "").trim();

      if (itemType && nonInventoryTypes.includes(itemType)) continue;

      const needUpdate = !currentSku || overwriteExisting;

      if (needUpdate && itemName) {
        const matchedRule = autoRules.find(rule => {
          const matchGrp = (!rule.sourceGrp || rule.sourceGrp === "ALL" || rule.sourceGrp === imGrp);
          if (!matchGrp) return false;
          return rule.regExps.some(rx => rx.test(itemName));
        });

        let targetSku = "";
        if (matchedRule) {
          targetSku = matchedRule.targetSku;
        } else if (imGrp === "INT") {
          targetSku = imCode.startsWith("INT_") 
            ? imCode.replace(/^INT_/, "SKU_") 
            : `SKU_${imCode}`;
        }

        if (targetSku && targetSku !== currentSku) {
          row[idxIM.sku] = targetSku;
          modifiedImRows.push(row);
          updatedCount++;
        }
      }
    }

    if (modifiedImRows.length > 0) {
      this.tableRepo.upsertRowsByTableName("ITEM_MASTER", modifiedImRows, ["item_code"]);
    }

    return updatedCount;
  }

  _buildItemMasterDict() {
    const imInfo = this.tableRepo.getDataByTableName("ITEM_MASTER");
    const rows = imInfo ? imInfo.values : [];
    const dict = {};

    if (rows && rows.length > 1) {
      const codeIdx = this._getColIndex("ITEM_MASTER", "item_code");
      const baseUnitIdx = this._getColIndex("ITEM_MASTER", "base_unit");

      if (codeIdx !== -1 && baseUnitIdx !== -1) {
        for (let i = 1; i < rows.length; i++) {
          const code = String(rows[i][codeIdx] || "").trim();
          if (code) {
            dict[code] = { baseUnit: String(rows[i][baseUnitIdx] || "").trim().toLowerCase() };
          }
        }
      }
    }
    return dict;
  }

  /**
   * Khởi tạo các dòng MAP_RULE ban đầu cho các raw_name xuất hiện trong RAW thuộc kỳ đang lọc
   */
  bootstrapMapRules(sourceGroup, periodList = null) {
    const srcMeta = this.sysConfigService.getSourceMetadata(sourceGroup);
    if (!srcMeta) return 0;

    const targetGrp = (srcMeta.mapRuleGroup || srcMeta.coreGroup || sourceGroup).toUpperCase();
    const rawSchemaName = srcMeta.rawSchema;

    const rawDataInfo = this.tableRepo.getDataByTableName(rawSchemaName);
    if (!rawDataInfo || !rawDataInfo.values || rawDataInfo.values.length <= 1) return 0;

    const idxRawName = this._getColIndex(rawSchemaName, "raw_name");
    const idxRawPeriod = this._getColIndex(rawSchemaName, "period");

    if (idxRawName === -1) return 0;

    const periodSet = (Array.isArray(periodList) && periodList.length > 0)
      ? new Set(periodList.map(p => this._normalizePeriod(p)))
      : null;

    // 1. Quét RAW để gom nhóm các raw_name duy nhất trong kỳ xử lý
    const uniqueRawNamesInRaw = new Set();
    const rawRows = rawDataInfo.values.slice(1);

    for (let i = 0; i < rawRows.length; i++) {
      const row = rawRows[i];

      if (periodSet && idxRawPeriod !== -1) {
        const periodVal = this._normalizePeriod(row[idxRawPeriod]);
        if (!periodSet.has(periodVal)) continue;
      }

      const rawName = String(row[idxRawName] || "").trim();
      if (rawName) {
        uniqueRawNamesInRaw.add(rawName);
      }
    }

    if (uniqueRawNamesInRaw.size === 0) return 0;

    // 2. Kiểm tra các cặp (source_grp, raw_name) đã tồn tại trong MAP_RULE
    const mapRuleInfo = this.tableRepo.getDataByTableName("MAP_RULE");
    const existingKeys = new Set();

    const schemaMap = this.schemaService.getSchemaMap();
    const mrColsConfig = schemaMap["MAP_RULE"] ? schemaMap["MAP_RULE"].columns : {};
    const totalMRCols = Math.max(...Object.values(mrColsConfig), 4);

    const idxMR = {
      sourceGrp: this._getColIndex("MAP_RULE", "source_grp"),
      rawName:   this._getColIndex("MAP_RULE", "raw_name"),
      itemName:  this._getColIndex("MAP_RULE", "item_name"),
      itemCode:  this._getColIndex("MAP_RULE", "item_code")
    };

    if (mapRuleInfo && mapRuleInfo.values && mapRuleInfo.values.length > 1) {
      const mrRows = mapRuleInfo.values.slice(1);
      for (let i = 0; i < mrRows.length; i++) {
        const grp = String(mrRows[i][idxMR.sourceGrp] || "").trim().toUpperCase();
        const raw = String(mrRows[i][idxMR.rawName] || "").trim().toLowerCase();
        if (grp && raw) {
          existingKeys.add(`${grp}___${raw}`);
        }
      }
    }

    // 3. Khởi tạo dòng mới vào MAP_RULE nếu chưa tồn tại
    const rowsToInsert = [];
    uniqueRawNamesInRaw.forEach(rawName => {
      const key = `${targetGrp}___${rawName.toLowerCase()}`;
      if (!existingKeys.has(key)) {
        const newRow = new Array(totalMRCols).fill("");
        if (idxMR.sourceGrp !== -1) newRow[idxMR.sourceGrp] = targetGrp;
        if (idxMR.rawName !== -1)   newRow[idxMR.rawName]   = rawName;
        // item_name và item_code để trống, các bước sau trong Pipeline sẽ điền/map tiếp
        
        rowsToInsert.push(newRow);
        existingKeys.add(key);
      }
    });

    if (rowsToInsert.length > 0) {
      this.tableRepo.upsertRowsByTableName("MAP_RULE", rowsToInsert, ["source_grp", "raw_name"]);
      Logger.log(`[BOOTSTRAP MAP_RULE] Đã khởi tạo mới ${rowsToInsert.length} bản ghi vào MAP_RULE cho nhóm [${targetGrp}].`);
    }

    return rowsToInsert.length;
  }






  
}
