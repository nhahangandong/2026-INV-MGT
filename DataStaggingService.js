/**
 * [SERVICE] DataStagingService - Tối ưu hiệu năng I/O & Batch Write
 */
class DataStagingService {
  constructor(tableRepo, schemaService, sysConfigService) {
    if (!tableRepo || !schemaService || !sysConfigService) {
      throw new Error("[DataStagingService] Thiếu Dependency (tableRepo, schemaService, sysConfigService).");
    }
    this.tableRepo = tableRepo;
    this.schemaService = schemaService;
    this.sysConfigService = sysConfigService;
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
        try { return new RegExp(escaped, "i"); } catch (e) { return null; }
      })
      .filter(regex => regex !== null);
  }

  _matchUnit(rawUnit, ruleUnitStr) {
    if (!ruleUnitStr) return true;
    if (!rawUnit) return false;
    const raw = String(rawUnit).trim().toLowerCase();
    const allowedUnits = String(ruleUnitStr).split(",").map(u => u.trim().toLowerCase()).filter(u => u.length > 0);
    return allowedUnits.includes(raw);
  }

  _getColIndex(schemaName, colKey) {
    const col1Based = this.schemaService.getColIndex(schemaName, colKey);
    return col1Based > 0 ? col1Based - 1 : -1;
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

  _detectInvoiceContexts(rawSchemaName, autoRules) {
    const rawDataInfo = this.tableRepo.getDataByTableName(rawSchemaName);
    if (!rawDataInfo || !rawDataInfo.values || rawDataInfo.values.length <= 1) return {};

    const idxInvCode = this._getColIndex(rawSchemaName, "invoice_code");
    const idxRawName = this._getColIndex(rawSchemaName, "raw_name");
    const idxUnit    = this._getColIndex(rawSchemaName, "unit");

    if (idxInvCode === -1) return {};

    const contextMap = {};
    const anchorRules = autoRules.filter(r => r.isAnchor);
    const vendorRules = autoRules.filter(r => r.vendorTaxCode);

    const rawRows = rawDataInfo.values.slice(1);
    rawRows.forEach(row => {
      const invCode = String(row[idxInvCode] || "").trim();
      if (!invCode) return;

      const hasVendorMatch = vendorRules.some(r => r.vendorTaxCode && invCode.includes(r.vendorTaxCode));
      if (hasVendorMatch) {
        contextMap[invCode] = "EXPENSE";
        return;
      }

      if (contextMap[invCode] !== "EXPENSE") {
        const rawName = idxRawName !== -1 ? String(row[idxRawName] || "").trim() : "";
        const unit    = idxUnit !== -1    ? String(row[idxUnit] || "").trim() : "";

        const isAnchorMatched = anchorRules.some(r => {
          const matchName = r.regExps.length > 0 && r.regExps.some(rx => rx.test(rawName));
          const matchUnit = this._matchUnit(unit, r.rawUnit);
          return matchName && matchUnit;
        });

        if (isAnchorMatched) contextMap[invCode] = "EXPENSE";
      }
    });

    return contextMap;
  }

  /** Ham bootstrap du lieu cho unit_conversion */
  bootstrapUnitConversionFromStaging() {
    const imDict = this._buildItemMasterDict();
    
    // 1. Lấy danh sách item_code hợp lệ (Active Set) từ MAP_RULE bằng schema_name
    const mapRuleInfo = this.tableRepo.getDataByTableName("MAP_RULE");
    const activeItemCodes = new Set();
    if (mapRuleInfo && mapRuleInfo.values && mapRuleInfo.values.length > 1) {
      const idxMRCode = this._getColIndex("MAP_RULE", "item_code");
      if (idxMRCode !== -1) {
        mapRuleInfo.values.slice(1).forEach(r => {
          const code = String(r[idxMRCode] || "").trim();
          if (code) activeItemCodes.add(code);
        });
      }
    }

    const ucInfo = this.tableRepo.getDataByTableName("UNIT_CONVERSION");
    if (!ucInfo || !ucInfo.values || ucInfo.values.length === 0) return 0;

    const headers = ucInfo.values[0];
    const grpIdx    = this._getColIndex("UNIT_CONVERSION", "source_grp");
    const codeIdx   = this._getColIndex("UNIT_CONVERSION", "item_code");
    const altIdx    = this._getColIndex("UNIT_CONVERSION", "alt_unit");
    const rawKwIdx  = this._getColIndex("UNIT_CONVERSION", "raw_keyword");
    const baseIdx   = this._getColIndex("UNIT_CONVERSION", "base_unit");
    const factorIdx = this._getColIndex("UNIT_CONVERSION", "conversion_factor");
    const statusIdx = this._getColIndex("UNIT_CONVERSION", "status");

    if (grpIdx === -1 || codeIdx === -1 || altIdx === -1) return 0;

    const totalCols = headers.length;
    const existingMap = new Map();
    const allDataRows = [];

    // 2. Duyệt qua TẤT CẢ các dòng hiện tại của UNIT_CONVERSION và ĐÁNH LẠI STATUS
    for (let i = 1; i < ucInfo.values.length; i++) {
      const row = [...ucInfo.values[i]];
      while (row.length < totalCols) row.push("");

      const g = String(row[grpIdx] || "INT").trim().toUpperCase();
      const c = String(row[codeIdx] || "").trim();
      const u = String(row[altIdx] || "").trim().toLowerCase();

      if (c) {
        // Đối chiếu với MAP_RULE để cập nhật status chuẩn xác
        if (statusIdx !== -1) {
          row[statusIdx] = activeItemCodes.has(c) ? "ACTIVE" : "NEED_REVIEW";
        }
        if (u) {
          existingMap.set(`${g}___${c}___${u}`, row);
        }
      }
      allDataRows.push(row);
    }

    // 3. Quét các bảng Staging (dùng chuẩn schema_name viết hoa)
    const stgTables = [
      { name: "STG_PO_INVOICE", grp: "INT" },
      { name: "STG_SO_INVOICE", grp: "OUT" },
      { name: "STG_INVENTORY_OPENING", grp: "INT" }
    ];

    stgTables.forEach(t => {
      const stgInfo = this.tableRepo.getDataByTableName(t.name);
      const rows = stgInfo ? stgInfo.values : [];
      if (!rows || rows.length <= 1) return;

      const codeStgIdx = this._getColIndex(t.name, "item_code");
      const unitStgIdx = this._getColIndex(t.name, "unit");

      if (codeStgIdx === -1 || unitStgIdx === -1) return;

      for (let i = 1; i < rows.length; i++) {
        const itemCode = String(rows[i][codeStgIdx] || "").trim();
        const stgUnit  = String(rows[i][unitStgIdx] || "").trim().toLowerCase();
        if (!itemCode || !stgUnit) continue;

        const imData   = imDict[itemCode] || {};
        const newBaseUnit = String(imData.baseUnit || "").trim().toLowerCase();

        if (newBaseUnit && stgUnit !== newBaseUnit) {
          const key = `${t.grp}___${itemCode}___${stgUnit}`;

          if (!existingMap.has(key)) {
            const newRow = new Array(totalCols).fill("");
            newRow[grpIdx] = t.grp;
            newRow[codeIdx] = itemCode;
            newRow[altIdx] = stgUnit;
            if (rawKwIdx !== -1)  newRow[rawKwIdx] = stgUnit;
            if (baseIdx !== -1)   newRow[baseIdx] = newBaseUnit;
            if (factorIdx !== -1) newRow[factorIdx] = 1;
            if (statusIdx !== -1) {
              newRow[statusIdx] = activeItemCodes.has(itemCode) ? "ACTIVE" : "NEED_REVIEW";
            }

            existingMap.set(key, newRow);
            allDataRows.push(newRow);
          }
        }
      }
    });

    // 4. Ghi toàn bộ dữ liệu trở lại bảng UNIT_CONVERSION thông qua schema_name
    const finalValues = [headers, ...allDataRows];
    this.tableRepo.writeTableByName("UNIT_CONVERSION", finalValues);

    return allDataRows.length;
  }

  // Ham ap dung quy tac auto map rule
  applyAutoMapNamesToMapRules(sourceGroup, overwriteExisting = true) {
    this.bootstrapMapRulesFromRaw(sourceGroup);

    const srcMeta = this.sysConfigService.getSourceMetadata(sourceGroup) || {};
    const targetGrp = (srcMeta.mapRuleGroup || srcMeta.coreGroup || sourceGroup).toUpperCase();
    const rawSchemaName = srcMeta.rawSchema;

    const rawIsInventory = (srcMeta.mapping && srcMeta.mapping.isInventory !== undefined)
      ? srcMeta.mapping.isInventory
      : srcMeta.isInventory;
      
    const isPureInventorySource = Boolean(rawIsInventory === true || String(rawIsInventory).toLowerCase() === "true");

    const rawNonInvConfig = this.sysConfigService.getConfig("NON_INVENTORY_ITEM_TYPES") || ["Chi phí", "Expense"];
    const nonInventoryItemTypes = (Array.isArray(rawNonInvConfig) ? rawNonInvConfig : String(rawNonInvConfig).split(","))
      .map(t => String(t).trim().toLowerCase())
      .filter(t => t.length > 0);

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
      sourceGrp:     this._getColIndex("AUTO_MAP_RULE", "source_grp"),
      vendorTaxCode: this._getColIndex("AUTO_MAP_RULE", "vendor_tax_code"),
      keyword:       kwIdx,
      rawUnit:       this._getColIndex("AUTO_MAP_RULE", "raw_unit"),
      itemName:      this._getColIndex("AUTO_MAP_RULE", "target_item_name"),
      priority:      prioIdx,
      isAnchor:      this._getColIndex("AUTO_MAP_RULE", "is_anchor")
    };

    const autoRules = autoMapInfo.values.slice(1)
      .map(r => ({
        sourceGrp:     idxAM.sourceGrp !== -1     ? String(r[idxAM.sourceGrp] || "").trim().toUpperCase() : "",
        vendorTaxCode: idxAM.vendorTaxCode !== -1 ? String(r[idxAM.vendorTaxCode] || "").trim() : "",
        regExps:       idxAM.keyword !== -1       ? this._parseWildcardToRegExps(String(r[idxAM.keyword] || "")) : [],
        rawUnit:       idxAM.rawUnit !== -1       ? String(r[idxAM.rawUnit] || "").trim() : "",
        itemName:      idxAM.itemName !== -1      ? String(r[idxAM.itemName] || "").trim() : "",
        priority:      idxAM.priority !== -1      ? Number(r[idxAM.priority] || 9999) : 9999,
        isAnchor:      idxAM.isAnchor !== -1      ? String(r[idxAM.isAnchor] || "").toUpperCase() === "TRUE" : false
      }))
      .sort((a, b) => a.priority - b.priority);

    const invoiceContexts = !isPureInventorySource ? this._detectInvoiceContexts(rawSchemaName, autoRules) : {};
    const hasInvoiceContext = Object.keys(invoiceContexts).length > 0;

    const rawDataInfo = this.tableRepo.getDataByTableName(rawSchemaName);
    const expenseRawContextMap = new Map();

    const activeRawNamesInSource = new Set();
    if (rawDataInfo && rawDataInfo.values && rawDataInfo.values.length > 1) {
      const idxRawName = this._getColIndex(rawSchemaName, "raw_name");
      const idxInvCode = this._getColIndex(rawSchemaName, "invoice_code");

      rawDataInfo.values.slice(1).forEach(row => {
        const rawName = idxRawName !== -1 ? String(row[idxRawName] || "").trim().toLowerCase() : "";
        if (rawName) activeRawNamesInSource.add(rawName);

        if (hasInvoiceContext && idxInvCode !== -1 && idxRawName !== -1) {
          const invCode = String(row[idxInvCode] || "").trim();
          if (invCode && rawName && invoiceContexts[invCode]) {
            const vendorMatchRule = autoRules.find(r => r.vendorTaxCode && invCode.includes(r.vendorTaxCode));
            expenseRawContextMap.set(rawName, {
              isExpense: true,
              targetItemName: vendorMatchRule ? vendorMatchRule.itemName : null
            });
          }
        }
      });
    }

    const mapRows = mapRuleInfo.values.slice(1);
    const modifiedRows = [];
    let updatedCount = 0;

    mapRows.forEach(row => {
      const rowSourceGrp = String(row[idxMR.sourceGrp] || "").trim().toUpperCase();
      if (targetGrp && rowSourceGrp !== targetGrp) return;

      const rawName = String(row[idxMR.rawName] || "").trim();
      const rawNameLower = rawName.toLowerCase();
      let currentItemName = String(row[idxMR.itemName] || "").trim();

      if (activeRawNamesInSource.size > 0 && !activeRawNamesInSource.has(rawNameLower)) {
        return;
      }

      let changed = false;

      if (!isPureInventorySource) {
        const expenseContext = expenseRawContextMap.get(rawNameLower);
        if (expenseContext && expenseContext.targetItemName) {
          if (currentItemName !== expenseContext.targetItemName) {
            row[idxMR.itemName] = expenseContext.targetItemName;
            updatedCount++;
            changed = true;
          }
          if (changed) modifiedRows.push(row);
          return;
        }
      }

      if (isPureInventorySource && currentItemName) {
        return;
      }

      const matchedRule = autoRules.find(rule => {
        const matchGrp = (!rule.sourceGrp || rule.sourceGrp === "ALL" || rule.sourceGrp === rowSourceGrp);
        if (!matchGrp) return false;

        if (isPureInventorySource) {
          if (rule.vendorTaxCode || rule.isAnchor) return false;
          const targetLower = String(rule.itemName || "").toLowerCase();
          if (nonInventoryItemTypes.some(typeKw => targetLower.includes(typeKw))) return false;
        }

        if (!isPureInventorySource) {
          if (rule.vendorTaxCode) return false;
          if (rule.isAnchor && (!hasInvoiceContext || !expenseContext)) return false;
        }

        return rule.regExps.length > 0 && rule.regExps.some(rx => rx.test(rawName));
      });

      if (matchedRule) {
        if (currentItemName !== matchedRule.itemName) {
          row[idxMR.itemName] = matchedRule.itemName;
          updatedCount++;
          changed = true;
        }
      } else if (isPureInventorySource && !currentItemName) {
        row[idxMR.itemName] = rawName;
        updatedCount++;
        changed = true;
      }

      if (changed) modifiedRows.push(row);
    });

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

    // 1. Đọc dữ liệu ITEM_MASTER hiện tại làm bộ nhớ đệm
    const existingIMMap = new Map();
    const itemRows = itemMasterInfo && itemMasterInfo.values ? itemMasterInfo.values.slice(1) : [];

    itemRows.forEach(row => {
      const code = String(row[idxIM.itemCode] || "").trim();
      if (code) {
        const fullRow = [...row];
        while (fullRow.length < totalIMCols) fullRow.push("");
        existingIMMap.set(code, fullRow);
      }
    });

    const mapRows = mapRuleInfo.values.slice(1);
    const newMasterRowsMap = new Map();
    const activeCodeSet = new Set();
    const modifiedMapRows = [];
    let generatedCount = 0;

    // Dictionary dùng để theo dõi việc trùng mã bỏ dấu trong cùng 1 đợt chạy
    // Key: baseCode (VD: INT_CHA_CA), Value: Map(itemNameLower -> finalCode)
    const generatedBaseCodesDict = new Map();

    // 2. Lặp qua MAP_RULE để sinh item_code (áp dụng Sequence nếu trùng)
    mapRows.forEach(row => {
      const sourceGrp = String(row[idxMR.sourceGrp] || "INT").trim().toUpperCase();
      const itemName  = String(row[idxMR.itemName] || "").trim();

      if (!itemName) return; // Chưa map tên thì bỏ qua

      const cleanNameNoTone = this._removeVietnameseTones(itemName)
        .replace(/[^a-zA-Z0-9\s_]/g, "")
        .trim()
        .replace(/\s+/g, "_")
        .toUpperCase();
      
      const baseCode = `${sourceGrp}_${cleanNameNoTone}`;
      const itemNameLower = itemName.toLowerCase().trim();

      // KHỞI TẠO HOẶC LẤY MAP XỬ LÝ TRÙNG LẮP
      if (!generatedBaseCodesDict.has(baseCode)) {
        generatedBaseCodesDict.set(baseCode, new Map());
      }
      const itemNamesUnderBaseCode = generatedBaseCodesDict.get(baseCode);

      let correctCode = "";

      // Kiểm tra xem item_name này đã từng được cấp code dưới baseCode này chưa
      if (itemNamesUnderBaseCode.has(itemNameLower)) {
        correctCode = itemNamesUnderBaseCode.get(itemNameLower);
      } else {
        // Nếu là item_name MỚI trùng baseCode với item_name KHÁC đã xử lý trước đó:
        const currentCount = itemNamesUnderBaseCode.size;
        if (currentCount === 0) {
          correctCode = baseCode; // Tên đầu tiên giữ mã gốc (VD: INT_CHA_CA)
        } else {
          correctCode = `${baseCode}_${currentCount}`; // Tên thứ 2 trở đi nhảy số (VD: INT_CHA_CA_1)
        }
        itemNamesUnderBaseCode.set(itemNameLower, correctCode);
      }

      activeCodeSet.add(correctCode);

      // Cập nhật lại MAP_RULE nếu mã thay đổi
      if (row[idxMR.itemCode] !== correctCode) {
        row[idxMR.itemCode] = correctCode;
        modifiedMapRows.push(row);
        generatedCount++;
      }

      // Chuẩn bị dòng dữ liệu cho ITEM_MASTER
      let masterRow = existingIMMap.has(correctCode)
        ? [...existingIMMap.get(correctCode)]
        : new Array(totalIMCols).fill("");

      if (idxIM.itemCode  !== -1) masterRow[idxIM.itemCode]  = correctCode;
      if (idxIM.sourceGrp !== -1) masterRow[idxIM.sourceGrp] = sourceGrp;
      if (idxIM.itemName  !== -1) masterRow[idxIM.itemName]  = itemName;

      // Đánh nhãn ACTIVE cho mã đang xuất hiện trong MAP_RULE
      if (idxIM.status !== -1) {
        masterRow[idxIM.status] = "ACTIVE";
      }

      newMasterRowsMap.set(correctCode, masterRow);
    });

    // Ghi đè MAP_RULE
    if (modifiedMapRows.length > 0) {
      this.tableRepo.upsertRowsByTableName("MAP_RULE", modifiedMapRows, ["source_grp", "raw_name"]);
    }

    // Upsert ITEM_MASTER
    if (newMasterRowsMap.size > 0) {
      const masterRowsToUpsert = Array.from(newMasterRowsMap.values());
      this.tableRepo.upsertRowsByTableName("ITEM_MASTER", masterRowsToUpsert, ["item_code"]);
    }

    // 3. CLEAN MÃ MỒ CÔI: Đánh dấu NEED_REVIEW cho mã không còn xuất hiện trong MAP_RULE
    if (idxIM.status !== -1) {
      const orphanRows = [];

      existingIMMap.forEach((row, code) => {
        if (!activeCodeSet.has(code)) {
          if (String(row[idxIM.status] || "").trim() !== "NEED_REVIEW") {
            row[idxIM.status] = "NEED_REVIEW";
            orphanRows.push(row);
          }
        }
      });

      if (orphanRows.length > 0) {
        this.tableRepo.upsertRowsByTableName("ITEM_MASTER", orphanRows, ["item_code"]);
      }
    }

    return generatedCount;
  }

  updateStagingMappedFields(sourceGroup, filter = null) {
    const srcMeta = this.sysConfigService.getSourceMetadata(sourceGroup);
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

    const mapDict = {};
    mapRuleInfo.values.slice(1).forEach(r => {
      const grp = String(r[idxMR.sourceGrp] || "").trim().toUpperCase();
      const raw = String(r[idxMR.rawName] || "").trim().toLowerCase();
      if ((grp === targetGrp || grp === "ALL") && raw) {
        mapDict[raw] = {
          itemName: String(r[idxMR.itemName] || "").trim(),
          itemCode: String(r[idxMR.itemCode] || "").trim()
        };
      }
    });

    const stgRows = stgDataInfo.values.slice(1);
    let updatedCount = 0;
    const modifiedStgRows = [];

    stgRows.forEach(row => {
      if (filter && filter.key && filter.values && idxSTG.period !== -1) {
        const periodVal = String(row[idxSTG.period] || "").trim();
        const targetPeriods = filter.values.map(v => String(v).trim());
        if (!targetPeriods.includes(periodVal)) return;
      }

      const rawName = String(row[idxSTG.rawName] || "").trim().toLowerCase();
      if (rawName && mapDict[rawName]) {
        const targetName = mapDict[rawName].itemName;
        const targetCode = mapDict[rawName].itemCode;

        const currentName = idxSTG.itemName !== -1 ? String(row[idxSTG.itemName] || "").trim() : "";
        const currentCode = idxSTG.itemCode !== -1 ? String(row[idxSTG.itemCode] || "").trim() : "";

        if (currentName !== targetName || currentCode !== targetCode) {
          const updatedRow = [...row];
          if (idxSTG.itemName !== -1) updatedRow[idxSTG.itemName] = targetName;
          if (idxSTG.itemCode !== -1) updatedRow[idxSTG.itemCode] = targetCode;
          modifiedStgRows.push(updatedRow);
          updatedCount++;
        }
      }
    });

    if (modifiedStgRows.length > 0) {
      this.tableRepo.upsertRowsByTableName(stgSchemaName, modifiedStgRows, srcMeta.primaryKeys);
    }

    return updatedCount;
  }

  /** bootstrap unit_conversion */
  bootstrapUnitConversionFromStaging() {
    // 1. Lấy Active Set từ MAP_RULE và Dict từ ITEM_MASTER (Đã được hoàn thiện trước đó)
    const mapRuleInfo = this.tableRepo.getDataByTableName("MAP_RULE");
    const activeItemCodes = new Set();
    if (mapRuleInfo && mapRuleInfo.values && mapRuleInfo.values.length > 1) {
      const idxMRCode = this._getColIndex("MAP_RULE", "item_code");
      if (idxMRCode !== -1) {
        mapRuleInfo.values.slice(1).forEach(r => {
          const code = String(r[idxMRCode] || "").trim();
          if (code) activeItemCodes.add(code);
        });
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

    // 2. Load các dòng hiện có của UNIT_CONVERSION & đồng bộ lại Status theo MAP_RULE
    if (ucRows && ucRows.length > 1) {
      for (let i = 1; i < ucRows.length; i++) {
        const g = String(ucRows[i][grpIdx] || "INT").trim().toUpperCase();
        const c = String(ucRows[i][codeIdx] || "").trim();
        const u = String(ucRows[i][altIdx] || "").trim().toLowerCase();

        if (c && u) {
          const fullRow = [...ucRows[i]];
          while (fullRow.length < totalCols) fullRow.push("");

          if (statusIdx !== -1) {
            const currentStatus = String(fullRow[statusIdx] || "").trim();
            const targetStatus = activeItemCodes.has(c) ? "ACTIVE" : "NEED_REVIEW";

            if (currentStatus !== targetStatus) {
              fullRow[statusIdx] = targetStatus;
              rowsToUpsert.push(fullRow);
            }
          }

          existingMap.set(`${g}___${c}___${u}`, fullRow);
        }
      }
    }

    // 3. Chỉ quét các nguồn phát sinh giao dịch (PO, SO) - LOẠI BỎ STG_INVENTORY_OPENING
    const stgTables = [
      { name: "STG_PO_INVOICE", grp: "INT" },
      { name: "STG_SO_INVOICE", grp: "OUT" }
    ];

    stgTables.forEach(t => {
      const stgInfo = this.tableRepo.getDataByTableName(t.name);
      const rows = stgInfo ? stgInfo.values : [];
      if (!rows || rows.length <= 1) return;

      // Đọc chỉ số cột trực tiếp từ Header thực tế của Staging
      const stgHeaders = rows[0].map(h => String(h || "").trim().toLowerCase());
      let codeStgIdx = stgHeaders.indexOf("item_code");
      let unitStgIdx = stgHeaders.indexOf("unit");

      if (codeStgIdx === -1) codeStgIdx = this._getColIndex(t.name, "item_code");
      if (unitStgIdx === -1) unitStgIdx = this._getColIndex(t.name, "unit");

      if (codeStgIdx === -1 || unitStgIdx === -1) return;

      for (let i = 1; i < rows.length; i++) {
        const itemCode = String(rows[i][codeStgIdx] || "").trim();
        const stgUnit  = String(rows[i][unitStgIdx] || "").trim().toLowerCase();
        if (!itemCode || !stgUnit) continue;

        const imData   = imDict[itemCode] || {};
        const baseUnit = String(imData.baseUnit || "").trim().toLowerCase();

        // ĐIỀU KIỆN QUAN TRỌNG: Chỉ tạo rule quy đổi nếu đơn vị giao dịch khác đơn vị cơ bản
        if (baseUnit && stgUnit !== baseUnit) {
          const key = `${t.grp}___${itemCode}___${stgUnit}`;

          if (!existingMap.has(key)) {
            const newRow = new Array(totalCols).fill("");
            newRow[grpIdx] = t.grp;
            newRow[codeIdx] = itemCode;
            newRow[altIdx] = stgUnit; // Đơn vị mua/bán lẻ (ví dụ: thùng)
            if (rawKwIdx !== -1)  newRow[rawKwIdx] = stgUnit;
            if (baseIdx !== -1)   newRow[baseIdx] = baseUnit; // Đơn vị chuẩn kho (ví dụ: lon)
            if (factorIdx !== -1) newRow[factorIdx] = "";    // Chờ người dùng điền hệ số quy đổi
            if (statusIdx !== -1) {
              newRow[statusIdx] = activeItemCodes.has(itemCode) ? "ACTIVE" : "NEED_REVIEW";
            }

            existingMap.set(key, newRow);
            rowsToUpsert.push(newRow);
          }
        }
      }
    });

    // 4. Upsert danh sách rule quy đổi mới/cập nhật vào UNIT_CONVERSION
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

    imRows.forEach(row => {
      const imGrp = idxIM.grp !== -1 ? String(row[idxIM.grp] || "").trim().toUpperCase() : "";
      const imCode = String(row[idxIM.code] || "").trim();
      const itemName = String(row[idxIM.name] || "").trim();
      const itemType = idxIM.type !== -1 ? String(row[idxIM.type] || "").trim().toUpperCase() : "";
      let currentSku = String(row[idxIM.sku] || "").trim();

      if (itemType && nonInventoryTypes.includes(itemType)) return;

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
          targetSku = imCode;
        }

        if (targetSku && targetSku !== currentSku) {
          row[idxIM.sku] = targetSku;
          modifiedImRows.push(row);
          updatedCount++;
        }
      }
    });

    if (modifiedImRows.length > 0) {
      this.tableRepo.upsertRowsByTableName("ITEM_MASTER", modifiedImRows, ["item_code"]);
    }

    return updatedCount;
  }

  /**
   * Chạy trọn gói Pipeline Staging & Chuẩn bị Fact
   */
  runStaging(sourceGroup, overridePrimaryKeys = null, filter = null) {
    this.applyAutoMapNamesToMapRules(sourceGroup);
    this.generateAndSyncItemCodes();
    const updatedStg = this.updateStagingMappedFields(sourceGroup, filter);

    this.bootstrapUnitConversionFromStaging();
    this.applyAutoSkuRules();

    // Tối ưu quan trọng: Ép xả bộ đệm ngay khi kết thúc xử lý ghi dữ liệu
    SpreadsheetApp.flush();

    return updatedStg;
  }
}
