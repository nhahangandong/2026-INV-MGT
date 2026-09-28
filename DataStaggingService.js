/**
 * [SERVICE] DataStagingService - Biến đổi, Làm sạch, Ánh xạ Danh mục Staging & Chuẩn bị Fact
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

  // ==========================================
  // HELPER UTILS
  // ==========================================

  /**
   * Helper loại bỏ dấu tiếng Việt và ký tự đặc biệt
   */
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

  /**
   * Helper chuyển đổi chuỗi chứa Wildcard (*) và dấu phẩy (,) thành danh sách các RegExp
   * Ví dụ: "*bia tươi carlsberg*tháp*" -> /bia tươi carlsberg.*tháp/i
   */
  _parseWildcardToRegExps(rawKwStr) {
    if (!rawKwStr) return [];
    
    return String(rawKwStr)
      .split(",")
      .map(pattern => {
        let trimmed = pattern.trim();
        if (!trimmed) return null;

        let escaped = trimmed.replace(/[\-\[\]\/\{\}\(\)\+\?\.\\\^\$\|]/g, "\\$&");
        escaped = escaped.replace(/\*+/g, ".*");

        try {
          return new RegExp(escaped, "i");
        } catch (e) {
          return null;
        }
      })
      .filter(regex => regex !== null);
  }

  /**
   * Helper lấy index cột an toàn dựa trên Schema (Trả về 0-based index, nếu không thấy trả về -1)
   */
  _getColIndex(schemaName, colKey) {
    const col1Based = this.schemaService.getColIndex(schemaName, colKey);
    return col1Based > 0 ? col1Based - 1 : -1;
  }

  /**
   * Dựng Dict thông tin ITEM_MASTER hỗ trợ tra cứu
   */
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
            dict[code] = {
              baseUnit: String(rows[i][baseUnitIdx] || "").trim().toLowerCase()
            };
          }
        }
      }
    }
    return dict;
  }

  // ==========================================
  // STAGING PIPELINE CORE (BUOC 0 - BUOC 3)
  // ==========================================

  /**
   * BƯỚC 0: Tự động quét RAW để bootstrap các mặt hàng mới (raw_name) sang MAP_RULE
   */
  bootstrapMapRulesFromRaw(sourceGroup) {
    const srcMeta = this.sysConfigService.getSourceMetadata(sourceGroup);
    const rawSchemaName = srcMeta.rawSchema;
    const mapRuleGroup = srcMeta.mapRuleGroup || srcMeta.coreGroup || "INT";

    const rawDataInfo = this.tableRepo.getDataByTableName(rawSchemaName);
    const mapRuleInfo = this.tableRepo.getDataByTableName("MAP_RULE");

    if (!rawDataInfo || !rawDataInfo.values || rawDataInfo.values.length <= 1) return 0;

    const idxRawName = this._getColIndex(rawSchemaName, "raw_name");
    if (idxRawName === -1) return 0;

    const idxMR = {
      sourceGrp: this._getColIndex("MAP_RULE", "source_grp"),
      rawName:   this._getColIndex("MAP_RULE", "raw_name")
    };

    const existingKeys = new Set();
    const mapRows = mapRuleInfo && mapRuleInfo.values ? mapRuleInfo.values.slice(1) : [];
    mapRows.forEach(r => {
      const grp = String(r[idxMR.sourceGrp] || "").trim().toUpperCase();
      const raw = String(r[idxMR.rawName] || "").trim().toLowerCase();
      if (grp && raw) existingKeys.add(`${grp}|${raw}`);
    });

    const schemaMap = this.schemaService.getSchemaMap();
    const mrColsConfig = schemaMap["MAP_RULE"] ? schemaMap["MAP_RULE"].columns : {};
    const totalCols = Math.max(...Object.values(mrColsConfig), 4);

    const idxMRFull = {
      sourceGrp: this._getColIndex("MAP_RULE", "source_grp"),
      rawName:   this._getColIndex("MAP_RULE", "raw_name"),
      itemName:  this._getColIndex("MAP_RULE", "item_name"),
      itemCode:  this._getColIndex("MAP_RULE", "item_code")
    };

    const rawRows = rawDataInfo.values.slice(1);
    const newMapRuleRows = [];

    rawRows.forEach(row => {
      const rawName = String(row[idxRawName] || "").trim();
      if (!rawName) return;

      const key = `${mapRuleGroup.toUpperCase()}|${rawName.toLowerCase()}`;
      if (!existingKeys.has(key)) {
        existingKeys.add(key);
        
        const newRow = new Array(totalCols).fill("");
        if (idxMRFull.sourceGrp !== -1) newRow[idxMRFull.sourceGrp] = mapRuleGroup.toUpperCase();
        if (idxMRFull.rawName !== -1)   newRow[idxMRFull.rawName]   = rawName;
        if (idxMRFull.itemName !== -1)  newRow[idxMRFull.itemName]  = "";
        if (idxMRFull.itemCode !== -1)  newRow[idxMRFull.itemCode]  = "";

        newMapRuleRows.push(newRow);
      }
    });

    if (newMapRuleRows.length > 0) {
      this.tableRepo.upsertRowsByTableName("MAP_RULE", newMapRuleRows, ["source_grp", "raw_name"]);
      Logger.log(`[BOOTSTRAP MAP_RULE] Đã bổ sung ${newMapRuleRows.length} mặt hàng mới vào MAP_RULE.`);
    }

    return newMapRuleRows.length;
  }

  /**
   * BƯỚC 1: Áp dụng AUTO_MAP_RULE để gợi ý tên chuẩn (item_name) vào MAP_RULE
   */
  applyAutoMapNamesToMapRules(sourceGroup, overwriteExisting = true) {
    this.bootstrapMapRulesFromRaw(sourceGroup);

    const srcMeta = this.sysConfigService.getSourceMetadata(sourceGroup);
    const targetGrp = (srcMeta.mapRuleGroup || srcMeta.coreGroup || sourceGroup).toUpperCase();

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

    // Hỗ trợ đọc priority (fallback đọc periority nếu typo)
    let prioIdx = this._getColIndex("AUTO_MAP_RULE", "priority");
    if (prioIdx === -1) prioIdx = this._getColIndex("AUTO_MAP_RULE", "periority");

    const idxAM = {
      sourceGrp: this._getColIndex("AUTO_MAP_RULE", "source_grp"),
      keyword:   kwIdx,
      itemName:  this._getColIndex("AUTO_MAP_RULE", "target_item_name"),
      priority:  prioIdx
    };

    const autoRules = autoMapInfo.values.slice(1)
      .map(r => ({
        sourceGrp: idxAM.sourceGrp !== -1 ? String(r[idxAM.sourceGrp] || "").trim().toUpperCase() : "",
        regExps:   idxAM.keyword !== -1   ? this._parseWildcardToRegExps(String(r[idxAM.keyword] || "")) : [],
        itemName:  idxAM.itemName !== -1  ? String(r[idxAM.itemName] || "").trim() : "",
        priority:  idxAM.priority !== -1  ? Number(r[idxAM.priority] || 9999) : 9999
      }))
      .filter(r => r.regExps.length > 0 && r.itemName)
      // SẮP XẾP PRIORITY TĂNG DẦN: Số nhỏ hơn chạy trước (a.priority - b.priority)
      .sort((a, b) => a.priority - b.priority);

    const mapRows = mapRuleInfo.values.slice(1);
    let updatedCount = 0;

    mapRows.forEach(row => {
      const rowSourceGrp = String(row[idxMR.sourceGrp] || "").trim().toUpperCase();
      if (targetGrp && rowSourceGrp !== targetGrp && rowSourceGrp !== "ALL") return;

      const rawName = String(row[idxMR.rawName] || "").trim();
      let currentItemName = String(row[idxMR.itemName] || "").trim();

      const needUpdate = !currentItemName || overwriteExisting;

      if (needUpdate && rawName) {
        // Quy tắc nào thỏa mãn trước (priority nhỏ nhất) sẽ được chọn ngay
        const matchedRule = autoRules.find(rule => {
          const matchGrp = (!rule.sourceGrp || rule.sourceGrp === "ALL" || rule.sourceGrp === rowSourceGrp);
          if (!matchGrp) return false;
          return rule.regExps.some(rx => rx.test(rawName));
        });

        if (matchedRule && currentItemName !== matchedRule.itemName) {
          row[idxMR.itemName] = matchedRule.itemName;
          updatedCount++;
        }
      }
    });

    if (updatedCount > 0) {
      this.tableRepo.upsertRowsByTableName("MAP_RULE", mapRows, ["source_grp", "raw_name"]);
      Logger.log(`[MAP RULE] Đã tự động gợi ý và cập nhật ${updatedCount} tên chuẩn cho nhóm [${targetGrp}].`);
    }

    return updatedCount;
  }

  /**
   * BƯỚC 2: Sinh mã item_code tự động từ item_name chuẩn & Sync sang ITEM_MASTER
   * Luồng chuẩn: MAP_RULE (source_grp + item_name) -> Sinh item_code -> Sync sang ITEM_MASTER
   */
  generateAndSyncItemCodes() {
    Logger.log(`[GEN CODE] Bắt đầu sinh mã item_code từ tên chuẩn...`);

    const itemMasterInfo = this.tableRepo.getDataByTableName("ITEM_MASTER");
    const mapRuleInfo     = this.tableRepo.getDataByTableName("MAP_RULE");

    if (!mapRuleInfo || !mapRuleInfo.values || mapRuleInfo.values.length <= 1) return 0;

    const schemaMap = this.schemaService.getSchemaMap();
    const imColsConfig = schemaMap["ITEM_MASTER"] ? schemaMap["ITEM_MASTER"].columns : {};
    const totalIMCols = Math.max(...Object.values(imColsConfig), 3);

    const idxIM = {
      itemCode:  this._getColIndex("ITEM_MASTER", "item_code"),
      sourceGrp: this._getColIndex("ITEM_MASTER", "source_grp"),
      itemName:  this._getColIndex("ITEM_MASTER", "item_name")
    };

    const idxMR = {
      sourceGrp: this._getColIndex("MAP_RULE", "source_grp"),
      rawName:   this._getColIndex("MAP_RULE", "raw_name"),
      itemName:  this._getColIndex("MAP_RULE", "item_name"),
      itemCode:  this._getColIndex("MAP_RULE", "item_code")
    };

    // Đọc thông tin các dòng hiện có của ITEM_MASTER để giữ lại các cột dữ liệu khác nếu có (như inventory_sku, item_type)
    const existingIMRowsByName = {}; 
    const itemRows = itemMasterInfo && itemMasterInfo.values ? itemMasterInfo.values.slice(1) : [];

    itemRows.forEach(row => {
      const name = String(row[idxIM.itemName] || "").trim();
      if (name) {
        const fullRow = [...row];
        while (fullRow.length < totalIMCols) fullRow.push("");
        // Lưu dòng cũ theo key item_name (KHÔNG ĐỌC HOẶC TÁI SỬ DỤNG ITEM_CODE CỦ TRONG ITEM_MASTER)
        existingIMRowsByName[name.toLowerCase().replace(/\s+/g, " ")] = fullRow;
      }
    });

    const mapRows = mapRuleInfo.values.slice(1);
    const newMasterRowsMap = new Map();
    let generatedCount = 0;

    mapRows.forEach(row => {
      const sourceGrp = String(row[idxMR.sourceGrp] || "INT").trim().toUpperCase();
      const itemName  = String(row[idxMR.itemName] || "").trim();

      if (!itemName) return;

      const cleanItemKey = itemName.toLowerCase().replace(/\s+/g, " ");

      // SINH MÃ CHUẨN TỰ ĐỘNG BẰNG HÀM SLUGIFY TỪ ITEM_NAME
      const cleanNameNoTone = this._removeVietnameseTones(itemName)
        .replace(/[^a-zA-Z0-9\s_]/g, "") // Loại bỏ các ký tự đặc biệt
        .trim()
        .replace(/\s+/g, "_")
        .toUpperCase();
      
      const correctCode = `${sourceGrp}_${cleanNameNoTone}`;

      // 1. Cập nhật mã chuẩn tuyệt đối vào MAP_RULE (Sửa đè mã sai cũ nếu có)
      if (row[idxMR.itemCode] !== correctCode) {
        row[idxMR.itemCode] = correctCode;
        generatedCount++;
      }

      // 2. Chuẩn bị dữ liệu đồng bộ đè sang ITEM_MASTER
      let masterRow = existingIMRowsByName[cleanItemKey] 
        ? [...existingIMRowsByName[cleanItemKey]] 
        : new Array(totalIMCols).fill("");

      if (idxIM.itemCode !== -1)  masterRow[idxIM.itemCode]  = correctCode;
      if (idxIM.sourceGrp !== -1) masterRow[idxIM.sourceGrp] = sourceGrp;
      if (idxIM.itemName !== -1)  masterRow[idxIM.itemName]  = itemName;

      newMasterRowsMap.set(cleanItemKey, masterRow);
    });

    // Sync 1 chiều từ MAP_RULE đẩy đè lại ITEM_MASTER
    if (newMasterRowsMap.size > 0) {
      const masterRowsToUpsert = Array.from(newMasterRowsMap.values());
      this.tableRepo.upsertRowsByTableName("ITEM_MASTER", masterRowsToUpsert, ["item_code"]);
    }

    if (mapRows.length > 0) {
      this.tableRepo.upsertRowsByTableName("MAP_RULE", mapRows, ["source_grp", "raw_name"]);
    }

    Logger.log(`[GEN CODE] Hoàn tất sinh & đồng bộ ${generatedCount} mã item_code chuẩn.`);
    return generatedCount;
  }

  /**
   * BƯỚC 3: Đồng bộ cặp (item_name, item_code) từ MAP_RULE sang bảng STAGING
   */
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

    const updatedStgRows = stgRows.map(row => {
      if (filter && filter.key && filter.values && idxSTG.period !== -1) {
        const periodVal = String(row[idxSTG.period] || "").trim();
        const targetPeriods = filter.values.map(v => String(v).trim());
        if (!targetPeriods.includes(periodVal)) return row;
      }

      const rawName = String(row[idxSTG.rawName] || "").trim().toLowerCase();
      if (rawName && mapDict[rawName]) {
        const updatedRow = [...row];
        if (idxSTG.itemName !== -1) updatedRow[idxSTG.itemName] = mapDict[rawName].itemName;
        if (idxSTG.itemCode !== -1) updatedRow[idxSTG.itemCode] = mapDict[rawName].itemCode;
        updatedCount++;
        return updatedRow;
      }
      return row;
    });

    if (updatedCount > 0) {
      this.tableRepo.upsertRowsByTableName(stgSchemaName, updatedStgRows, srcMeta.primaryKeys);
      Logger.log(`[STAGING SYNC] Đã cập nhật item_name/item_code cho ${updatedCount} dòng trên [${stgSchemaName}].`);
    }

    return updatedCount;
  }

  // ==========================================
  // FACT PREPARATION EXTENSIONS (BUOC 4A & 4B)
  // ==========================================

  /**
   * BƯỚC 4A: Bootstrap & Đồng bộ các cặp đơn vị quy đổi (alt_unit) từ STG sang UNIT_CONVERSION
   */
  bootstrapUnitConversionFromStaging() {
    const imDict = this._buildItemMasterDict();
    
    const ucInfo = this.tableRepo.getDataByTableName("UNIT_CONVERSION");
    const ucRows = ucInfo ? ucInfo.values : [];

    const grpIdx    = this._getColIndex("UNIT_CONVERSION", "source_grp");
    const codeIdx   = this._getColIndex("UNIT_CONVERSION", "item_code");
    const altIdx    = this._getColIndex("UNIT_CONVERSION", "alt_unit");
    const rawKwIdx  = this._getColIndex("UNIT_CONVERSION", "raw_keyword");
    const baseIdx   = this._getColIndex("UNIT_CONVERSION", "base_unit");
    const factorIdx = this._getColIndex("UNIT_CONVERSION", "conversion_factor");

    if (grpIdx === -1 || codeIdx === -1 || altIdx === -1 || baseIdx === -1) {
      throw new Error("[Schema Error] Bảng UNIT_CONVERSION thiếu các cấu hình col_key bắt buộc trong SCHEMA.");
    }

    const schemaMap = this.schemaService.getSchemaMap();
    const ucColsConfig = schemaMap["UNIT_CONVERSION"] ? schemaMap["UNIT_CONVERSION"].columns : {};
    const totalCols = Math.max(...Object.values(ucColsConfig), 6);

    const existingMap = new Map();

    if (ucRows && ucRows.length > 1) {
      for (let i = 1; i < ucRows.length; i++) {
        const g = String(ucRows[i][grpIdx] || "INT").trim().toUpperCase();
        const c = String(ucRows[i][codeIdx] || "").trim();
        const u = String(ucRows[i][altIdx] || "").trim().toLowerCase();
        if (c && u) {
          existingMap.set(`${g}___${c}___${u}`, ucRows[i]);
        }
      }
    }

    const rowsToUpsert = [];
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
            newRow[baseIdx] = newBaseUnit;
            if (factorIdx !== -1) newRow[factorIdx] = 1;

            existingMap.set(key, newRow);
            rowsToUpsert.push(newRow);
          } else {
            const existingRow = existingMap.get(key);
            const currentBaseUnit = String(existingRow[baseIdx] || "").trim().toLowerCase();

            if (currentBaseUnit !== newBaseUnit) {
              existingRow[baseIdx] = newBaseUnit;
              rowsToUpsert.push(existingRow);
            }
          }
        }
      }
    });

    if (rowsToUpsert.length > 0) {
      this.tableRepo.upsertRowsByTableName("UNIT_CONVERSION", rowsToUpsert, ["source_grp", "item_code", "alt_unit"]);
      Logger.log(`[BOOTSTRAP UC] Đã đồng bộ/thêm mới ${rowsToUpsert.length} dòng quy đổi vào UNIT_CONVERSION.`);
    }

    return rowsToUpsert.length;
  }

  /**
   * BƯỚC 4B: Tự động gán Mã Tồn kho Quy chuẩn (inventory_sku) cho ITEM_MASTER từ AUTO_SKU_RULE
   * 
   * Quy tắc xử lý:
   * 1. Lọc bỏ các mặt hàng thuộc nhóm không tính tồn kho (cấu hình động via SysConfig KEY: NON_INVENTORY_ITEM_TYPES).
   * 2. Quét các quy tắc AUTO_SKU_RULE theo thứ tự priority tăng dần (số nhỏ chạy trước).
   * 3. Fallback: Nếu không khớp rule, nhóm INT được phép lấy tạm item_code làm inventory_sku;
   *    Nhóm OUT không tự fallback (giữ rỗng và ghi log cảnh báo validation).
   * 
   * @param {boolean} overwriteExisting - Có ghi đè mã inventory_sku đã tồn tại hay không
   * @returns {number} Số lượng dòng trong ITEM_MASTER được cập nhật
   */
  applyAutoSkuRules(overwriteExisting = false) {
    const imInfo = this.tableRepo.getDataByTableName("ITEM_MASTER");
    const autoSkuInfo = this.tableRepo.getDataByTableName("AUTO_SKU_RULE");

    if (!imInfo || !imInfo.values || imInfo.values.length <= 1) return 0;
    if (!autoSkuInfo || !autoSkuInfo.values || autoSkuInfo.values.length <= 1) return 0;

    // Lấy danh sách item_type không quản lý tồn kho từ SysConfig (Dynamic Key, không hardcode)
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

    // Chuẩn hóa và Sắp xếp Rule theo Priority tăng dần (Số nhỏ hơn chạy trước)
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
    let updatedCount = 0;
    const unmappedOutItems = [];

    imRows.forEach(row => {
      const imGrp = idxIM.grp !== -1 ? String(row[idxIM.grp] || "").trim().toUpperCase() : "";
      const imCode = String(row[idxIM.code] || "").trim();
      const itemName = String(row[idxIM.name] || "").trim();
      const itemType = idxIM.type !== -1 ? String(row[idxIM.type] || "").trim().toUpperCase() : "";
      let currentSku = String(row[idxIM.sku] || "").trim();

      // Bỏ qua các mặt hàng thuộc loại không tính tồn kho theo cấu hình trong SysConfig
      if (itemType && nonInventoryTypes.includes(itemType)) return;

      const needUpdate = !currentSku || overwriteExisting;

      if (needUpdate && itemName) {
        // 1. Tìm quy tắc khớp trong AUTO_SKU_RULE
        const matchedRule = autoRules.find(rule => {
          const matchGrp = (!rule.sourceGrp || rule.sourceGrp === "ALL" || rule.sourceGrp === imGrp);
          if (!matchGrp) return false;
          return rule.regExps.some(rx => rx.test(itemName));
        });

        if (matchedRule) {
          row[idxIM.sku] = matchedRule.targetSku;
          updatedCount++;
        } else {
          // 2. Phân luồng Fallback khi KHÔNG MATCH RULE:
          if (imGrp === "INT") {
            // Hàng nhập mua (INT): Cho phép lấy tạm item_code làm inventory_sku
            row[idxIM.sku] = imCode;
            updatedCount++;
          } else if (imGrp === "OUT") {
            // Hàng bán ra (OUT): Tuyệt đối KHÔNG tự fallback, giữ rỗng và thu thập danh sách báo cảnh báo
            unmappedOutItems.push(`${imCode} - ${itemName}`);
          }
        }
      }
    });

    if (updatedCount > 0) {
      this.tableRepo.upsertRowsByTableName("ITEM_MASTER", imRows, ["item_code"]);
      Logger.log(`[AUTO SKU] Đã cập nhật mã inventory_sku cho ${updatedCount} mặt hàng trong ITEM_MASTER.`);
    }

    if (unmappedOutItems.length > 0) {
      Logger.log(`[WARNING AUTO SKU] Phát hiện ${unmappedOutItems.length} mặt hàng OUT chưa được map inventory_sku: \n - ${unmappedOutItems.join("\n - ")}`);
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
    this.applyAutoSkuRules(); // Đã đổi tên gọn nhẹ

    return updatedStg;
  }
}
