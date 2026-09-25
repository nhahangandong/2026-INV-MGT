/**
 * [CLASS] DataStagingService
 * Quản lý toàn bộ quy trình Staging, Chuẩn hóa dữ liệu, Auto Map Rules, Sinh Mã SKU
 * và Đồng bộ Quy cách Đơn vị tính sang UNIT_CONVERSION
 */
class DataStagingService {
  constructor(tableRepo, schemaService, sysConfigService = null) {
    this.tableRepo = tableRepo;
    this.schemaService = schemaService;
    this.sysConfigService = sysConfigService;
    
    // Delimiter chuẩn hóa cho composite keys toàn hệ thống
    this.KEY_DELIMITER = "___";
  }

  /**
   * Đọc cấu hình từ SysConfigService (nếu có) hoặc fallback về cấu hình mặc định
   */
  _getSystemConfigs() {
    // Giá trị Mặc định (Fallback)
    const defaults = {
      sourceGroupMap: { PO: "INT", RAW_PO: "INT", SO: "OUT", RAW_SO: "OUT", INT: "INT", OUT: "OUT" },
      rawSchemaMap: { INT: "RAW_PO_INVOICE", OUT: "RAW_SO_INVOICE" },
      stgSchemaMap: { INT: "STG_PO_INVOICE", OUT: "STG_SO_INVOICE" },
      itemTypeInt: "MERCHANDISE",
      itemTypeOut: "FINISHED_GOODS",
      defaultUnit: "pcs"
    };

    if (!this.sysConfigService) {
      return defaults;
    }

    try {
      const srcMapStr  = this.sysConfigService.getConfig("SRC_GRP_MAP");
      const rawMapStr  = this.sysConfigService.getConfig("RAW_SCHEMA_MAP");
      const stgMapStr  = this.sysConfigService.getConfig("STG_SCHEMA_MAP");
      const typeInt    = this.sysConfigService.getConfig("DEFAULT_ITEM_TYPE_INT");
      const typeOut    = this.sysConfigService.getConfig("DEFAULT_ITEM_TYPE_OUT");
      const baseUnit   = this.sysConfigService.getConfig("DEFAULT_BASE_UNIT");

      if (srcMapStr) {
        try { Object.assign(defaults.sourceGroupMap, JSON.parse(srcMapStr)); } catch (e) { Logger.log("[CONFIG] Lỗi parse JSON SRC_GRP_MAP"); }
      }
      if (rawMapStr) {
        try { Object.assign(defaults.rawSchemaMap, JSON.parse(rawMapStr)); } catch (e) { Logger.log("[CONFIG] Lỗi parse JSON RAW_SCHEMA_MAP"); }
      }
      if (stgMapStr) {
        try { Object.assign(defaults.stgSchemaMap, JSON.parse(stgMapStr)); } catch (e) { Logger.log("[CONFIG] Lỗi parse JSON STG_SCHEMA_MAP"); }
      }
      if (typeInt) defaults.itemTypeInt = typeInt;
      if (typeOut) defaults.itemTypeOut = typeOut;
      if (baseUnit) defaults.defaultUnit = baseUnit;

    } catch (e) {
      Logger.log(`[CONFIG WARNING] Lỗi khi tra cứu SysConfigService: ${e.message}`);
    }

    return defaults;
  }

  _getSchemaMap() {
    return (this.schemaService && typeof this.schemaService.getSchemaMap === 'function') 
      ? this.schemaService.getSchemaMap() 
      : {};
  }

  /**
   * Chuẩn hóa mã nhóm nguồn dựa theo bảng ánh xạ từ SysConfigService
   */
  _normalizeSourceGroup(rawGroup) {
    const configs = this._getSystemConfigs();
    const grp = String(rawGroup || "").trim().toUpperCase();
    if (!grp) return "INT";

    if (Object.values(configs.sourceGroupMap).includes(grp)) {
      return grp;
    }

    return configs.sourceGroupMap[grp] || grp;
  }

 
  /**
   * TÍNH LẠI BASE_QTY VÀ BASE_PRICE TRÊN BẢNG STAGING & ITEM_MASTER
   * Cập nhật lại hệ số từ UNIT_CONVERSION khi có sự điều chỉnh trên bảng UNIT_CONVERSION.
   * 
   * @param {string} sourceGroup - "PO", "SO", "INT", "OUT"
   * @returns {Object} Số lượng dòng được cập nhật trên Staging và Item Master
   */
  recalculateStagingBaseValues(sourceGroup = "PO") {
    const sysConfig = this._getSystemConfigs();
    const targetGrp = this._normalizeSourceGroup(sourceGroup);
    const stgSchemaKey = sysConfig.stgSchemaMap[targetGrp] || "STG_PO_INVOICE";

    // 1. Nạp Từ điển Quy đổi từ UNIT_CONVERSION
    const ucDict = this._buildUnitConversionDictionary();

    // 2. Đọc dữ liệu từ bảng Staging hiện tại
    const stgInfo = this.tableRepo.getDataByTableName(stgSchemaKey);
    const stgRows = stgInfo ? stgInfo.values : [];
    if (!stgRows || stgRows.length <= 1) {
      Logger.log(`[RECALC STG] Bảng ${stgSchemaKey} không có dữ liệu.`);
      return { updatedStg: 0, updatedMaster: 0 };
    }

    // Lấy vị trí các cột theo Schema
    const itemCodeIdx   = this._getColIndex(stgSchemaKey, "item_code");
    const unitIdx       = this._getColIndex(stgSchemaKey, "unit");
    const qtyIdx        = this._getColIndex(stgSchemaKey, "quantity");
    const priceIdx      = this._getColIndex(stgSchemaKey, "price");
    const baseUnitIdx   = this._getColIndex(stgSchemaKey, "base_unit");
    const factorIdx     = this._getColIndex(stgSchemaKey, "conversion_factor");
    const baseQtyIdx    = this._getColIndex(stgSchemaKey, "base_qty");
    const basePriceIdx  = this._getColIndex(stgSchemaKey, "base_price");

    if (qtyIdx === -1 || priceIdx === -1 || factorIdx === -1 || baseQtyIdx === -1 || basePriceIdx === -1) {
      Logger.log(`[ERROR] Thiếu cột bắt buộc để Recalculate trong schema ${stgSchemaKey}`);
      return { updatedStg: 0, updatedMaster: 0 };
    }

    const parseNum = (val) => {
      if (typeof val === 'number') return isNaN(val) ? 0 : val;
      if (!val) return 0;
      const cleanStr = String(val).replace(/,/g, '').trim();
      const num = Number(cleanStr);
      return isNaN(num) ? 0 : num;
    };

    let updatedStgCount = 0;
    const masterConversionMap = {}; // Lưu thông tin factor mới để đồng bộ sang ITEM_MASTER

    // 3. Duyệt qua từng dòng Staging và tính lại theo UNIT_CONVERSION
    for (let i = 1; i < stgRows.length; i++) {
      const row = stgRows[i];
      const itemCode = String(row[itemCodeIdx] || "").trim();
      const unit     = String(row[unitIdx] || "").trim().toLowerCase();
  
      if (!itemCode) continue;

      // Tra cứu lại từ UNIT_CONVERSION dictionary
      const ucKey  = [itemCode, unit].join(this.KEY_DELIMITER);
      const ucData = ucDict[ucKey];

      const qty    = parseNum(row[qtyIdx]);
      const price  = parseNum(row[priceIdx]);
  
      // Nếu tìm thấy trên UNIT_CONVERSION thì dùng factor mới, ngược lại dùng factor hiện tại trên dòng
      const factor   = ucData ? parseNum(ucData.factor) : (parseNum(row[factorIdx]) || 1);
      const baseUnit = ucData ? ucData.baseUnit : String(row[baseUnitIdx] || "");

      const newBaseQty   = qty * factor;
      const newBasePrice = factor !== 0 ? price / factor : price;

      // Cập nhật lại nếu có chênh lệch
      if (row[factorIdx] !== factor || row[baseUnitIdx] !== baseUnit || row[baseQtyIdx] !== newBaseQty || row[basePriceIdx] !== newBasePrice) {
        if (baseUnitIdx !== -1) row[baseUnitIdx] = baseUnit;
        row[factorIdx]     = factor;
        row[baseQtyIdx]    = newBaseQty;
        row[basePriceIdx]  = newBasePrice;
        updatedStgCount++;
      }

      // Lưu lại thông tin cập nhật cho ITEM_MASTER
      if (ucData) {
        masterConversionMap[itemCode] = { baseUnit: baseUnit, factor: factor };
      }
    }

    // Ghi đè lại bảng Staging
    if (updatedStgCount > 0) {
      this.tableRepo.updateTableData(stgSchemaKey, stgRows);
      Logger.log(`[RECALC STG] Đã cập nhật lại base values cho ${updatedStgCount} dòng trên ${stgSchemaKey}.`);
    }

    // 4. Đồng bộ sang ITEM_MASTER
    let updatedMasterCount = 0;
    const imInfo = this.tableRepo.getDataByTableName("ITEM_MASTER");
    const imRows = imInfo ? imInfo.values : [];

    if (imRows && imRows.length > 1) {
      const imCodeIdx   = this._getColIndex("ITEM_MASTER", "item_code");
      const imFactorIdx = this._getColIndex("ITEM_MASTER", "stg_factor_to_base");
      const imBaseUIdx  = this._getColIndex("ITEM_MASTER", "base_unit");

      if (imCodeIdx !== -1 && imFactorIdx !== -1) {
        for (let i = 1; i < imRows.length; i++) {
          const code = String(imRows[i][imCodeIdx] || "").trim();
          if (code && masterConversionMap[code]) {
            const newFactor   = masterConversionMap[code].factor;
            const newBaseUnit = masterConversionMap[code].baseUnit;

            if (imRows[i][imFactorIdx] !== newFactor || (imBaseUIdx !== -1 && imRows[i][imBaseUIdx] !== newBaseUnit)) {
              imRows[i][imFactorIdx] = newFactor;
              if (imBaseUIdx !== -1) imRows[i][imBaseUIdx] = newBaseUnit;
              updatedMasterCount++;
            }
          }
        }

        if (updatedMasterCount > 0) {
          this.tableRepo.updateTableData("ITEM_MASTER", imRows);
          Logger.log(`[SYNC MASTER] Đã cập nhật ${updatedMasterCount} dòng trên ITEM_MASTER`);
        }
      }
    }

    return { updatedStg: updatedStgCount, updatedMaster: updatedMasterCount };
  }

  
  /**
   * Tự động thu gom/khởi tạo dữ liệu từ RAW sang MAP_RULE và UNIT_CONVERSION nếu thiếu
   */
  bootstrapDictionaries(sourceGroup = "PO") {
    const sysConfig = this._getSystemConfigs();
    const targetGrp = this._normalizeSourceGroup(sourceGroup);
    const rawSchemaKey = sysConfig.rawSchemaMap[targetGrp] || "RAW_PO_INVOICE";

    const rawInfo = this.tableRepo.getDataByTableName(rawSchemaKey);
    const rawRows = rawInfo ? rawInfo.values : [];
    if (!rawRows || rawRows.length <= 1) return 0;

    const rawNameIdx = this._getColIndex(rawSchemaKey, "raw_name");
    const unitIdx    = this._getColIndex(rawSchemaKey, "unit");
    if (rawNameIdx === -1) return 0;

    let totalBootstrapped = 0;

    // 1. BOOTSTRAP MAP_RULE
    const mapInfo = this.tableRepo.getDataByTableName("MAP_RULE");
    const mapRows = mapInfo ? mapInfo.values : [];
    const grpIdx  = this._getColIndex("MAP_RULE", "source_grp");
    
    const hasGroupDataInMap = mapRows.some((r, i) => i > 0 && this._normalizeSourceGroup(r[grpIdx]) === targetGrp);

    if (!hasGroupDataInMap) {
      const newMapRows = [];
      const uniqueNames = new Set();

      for (let i = 1; i < rawRows.length; i++) {
        const rawName = String(rawRows[i][rawNameIdx] || "").trim();
        if (rawName && !uniqueNames.has(rawName)) {
          uniqueNames.add(rawName);
          const generatedCode = this._generateItemCode(targetGrp, rawName);
          
          // Dùng schema để build dòng mới cho MAP_RULE
          const mapRawIdx  = this._getColIndex("MAP_RULE", "raw_name");
          const mapItemIdx = this._getColIndex("MAP_RULE", "item_name");
          const mapCodeIdx = this._getColIndex("MAP_RULE", "item_code");

          const maxCols = Math.max(grpIdx, mapRawIdx, mapItemIdx, mapCodeIdx) + 1;
          const newRow = new Array(maxCols).fill("");
          if (grpIdx !== -1)     newRow[grpIdx]     = targetGrp;
          if (mapRawIdx !== -1)  newRow[mapRawIdx]  = rawName;
          if (mapItemIdx !== -1) newRow[mapItemIdx] = rawName;
          if (mapCodeIdx !== -1) newRow[mapCodeIdx] = generatedCode;

          newMapRows.push(newRow);
        }
      }
      if (newMapRows.length > 0) {
        this.tableRepo.upsertRowsByTableName("MAP_RULE", newMapRows, ["source_grp", "raw_name"]);
        Logger.log(`[BOOTSTRAP] Khởi tạo thành công ${newMapRows.length} dòng cho MAP_RULE (${targetGrp})`);
        totalBootstrapped += newMapRows.length;
      }
    }

    // 2. BOOTSTRAP UNIT_CONVERSION
    if (unitIdx !== -1) {
      const ucInfo = this.tableRepo.getDataByTableName("UNIT_CONVERSION");
      const ucRows = ucInfo ? ucInfo.values : [];
      const ucGrpIdx = this._getColIndex("UNIT_CONVERSION", "source_grp");

      const hasGroupDataInUC = ucRows.some((r, i) => i > 0 && this._normalizeSourceGroup(r[ucGrpIdx]) === targetGrp);

      if (!hasGroupDataInUC) {
        const mapDict = this._buildMapRulesDictionary();
        const newUCRows = [];
        const processedPairs = new Set();
        const fallbackUnit = sysConfig.defaultUnit || "pcs";

        for (let i = 1; i < rawRows.length; i++) {
          const rawName = String(rawRows[i][rawNameIdx] || "").trim();
          const unit    = String(rawRows[i][unitIdx] || fallbackUnit).trim();
          if (!rawName) continue;

          const itemCode = mapDict[rawName] ? mapDict[rawName].itemCode : "";
          if (itemCode) {
            const pairKey = [targetGrp, itemCode, unit.toLowerCase()].join(this.KEY_DELIMITER);
            if (!processedPairs.has(pairKey)) {
              processedPairs.add(pairKey);
              
              const ucCodeIdx     = this._getColIndex("UNIT_CONVERSION", "item_code");
              const ucAltIdx      = this._getColIndex("UNIT_CONVERSION", "alt_unit");
              const ucRawKeyIdx   = this._getColIndex("UNIT_CONVERSION", "raw_keyword");
              const ucBaseIdx     = this._getColIndex("UNIT_CONVERSION", "base_unit");
              const ucFactorIdx   = this._getColIndex("UNIT_CONVERSION", "conversion_factor");

              const maxCols = Math.max(ucGrpIdx, ucCodeIdx, ucAltIdx, ucRawKeyIdx, ucBaseIdx, ucFactorIdx) + 1;
              const newRow = new Array(maxCols).fill("");
              if (ucGrpIdx !== -1)   newRow[ucGrpIdx]   = targetGrp;
              if (ucCodeIdx !== -1)  newRow[ucCodeIdx]  = itemCode;
              if (ucAltIdx !== -1)   newRow[ucAltIdx]   = unit;
              if (ucRawKeyIdx !== -1) newRow[ucRawKeyIdx] = unit;
              if (ucBaseIdx !== -1)   newRow[ucBaseIdx]   = unit.toLowerCase();
              if (ucFactorIdx !== -1) newRow[ucFactorIdx] = 1;

              newUCRows.push(newRow);
            }
          }
        }
        if (newUCRows.length > 0) {
          this.tableRepo.upsertRowsByTableName("UNIT_CONVERSION", newUCRows, ["source_grp", "item_code", "alt_unit"]);
          Logger.log(`[BOOTSTRAP] Khởi tạo thành công ${newUCRows.length} dòng cho UNIT_CONVERSION (${targetGrp})`);
        }
      }
    }

    return totalBootstrapped;
  }


  /**
   * Chay toan bo quy trinh Staging du lieu tho
   * @param {string} sourceGroup - "PO" hoac "SO"
   * @param {Array<string>} primaryKeys - Danh sach cac cot khoa do Controller chi dinh
   * @param {Object} filters - Co che loc nhieu gia tri: { col_key: [value1, value2] hoac value }
   */
  runStaging(sourceGroup = "PO", primaryKeys = null, filters = null) {
    const normalizedGrp = this._normalizeSourceGroup(sourceGroup);
    Logger.log(`[STAGING] Bat dau tien trinh Staging cho nguon: ${sourceGroup} (${normalizedGrp})...`);

    // 1. Thu gom raw_name chua co vao MAP_RULE
    const collectedCount = this.bootstrapDictionaries(normalizedGrp);

    // 2. Goi y ten chuan tu AUTO_MAP_RULE
    const autoMappedCount = this.applyAutoMapNamesToMapRules(normalizedGrp);

    // 3. Sinh ma SKU (item_code) cho MAP_RULE
    const generatedCodeCount = this.generateItemCodesForMapRules(normalizedGrp);

    // 4. Dong bo ma SKU moi tu MAP_RULE sang ITEM_MASTER
    const itemMasterCount = this.syncItemMasterFromMapRules(normalizedGrp);

    // 4b. TU DONG MAP INGREDIENT_CODE CHO ITEM_MASTER (GỌI TẠI ĐÂY)
    // Cần gọi ngay sau khi ITEM_MASTER đã được bổ sung các item_code/item_name mới từ bước 4
    const ingredientMappedCount = this.applyAutoIngredientCodesToItemMaster(normalizedGrp);

    // 5. Dong bo quy cach DVT sang UNIT_CONVERSION
    const newUnitCount = this.syncMissingUnitConversions(normalizedGrp);
    
    // 6. Bien doi du lieu tho sang STG (Giu nguyen dung ten ham goc)
    const stgTransformedCount = this.transformAndSaveStagingData(normalizedGrp, primaryKeys, filters);

    Logger.log(`[STAGING] Hoan tat ${sourceGroup}. Collect: ${collectedCount}, AutoMap: ${autoMappedCount}, SKU: ${generatedCodeCount}, ItemMaster: ${itemMasterCount}, AutoIngredient: ${ingredientMappedCount}, DVT: ${newUnitCount}, STG: ${stgTransformedCount} dong.`);
    
    return {
      sourceGroup: sourceGroup,
      normalizedGroup: normalizedGrp,
      collectedCount: collectedCount,
      autoMappedCount: autoMappedCount,
      generatedCodeCount: generatedCodeCount,
      itemMasterCount: itemMasterCount,
      ingredientMappedCount: ingredientMappedCount,
      newUnitCount: newUnitCount,
      stgTransformedCount: stgTransformedCount
    };
  }

  /**
   * BUOC 4: TRANSFORM DU LIEU TU RAW SANG STG (DYNAMIC SCHEMA-DRIVEN)
   * @param {string} sourceGroup - "INT" hoac "OUT"
   * @param {Array<string>} primaryKeys - Nhan danh sach khoa chinh dong tu Controller
   * @param {Object} filters - Dieu kien loc theo col_key { period: ["2026-03", "2026-04"], status: "APPROVED" }
   */
  transformAndSaveStagingData(sourceGroup = "INT", primaryKeys = null, filters = null) {
    const sysConfig = this._getSystemConfigs();
    const targetGrp = this._normalizeSourceGroup(sourceGroup);
    
    const rawSchemaKey = sysConfig.rawSchemaMap[targetGrp] || "RAW_PO_INVOICE";
    const stgSchemaKey = sysConfig.stgSchemaMap[targetGrp] || "STG_PO_INVOICE";

    // 1. Doc du lieu tho tu TableRepository
    const rawInfo = this.tableRepo.getDataByTableName(rawSchemaKey);
    const rawRows = rawInfo ? rawInfo.values : [];
    if (!rawRows || rawRows.length <= 1) return 0;

    // 2. Lay SCHEMA dong cua RAW & STG thong qua SchemaService
    const rawColumns = this._getSchemaColumnsList(rawSchemaKey);
    const stgColumns = this._getSchemaColumnsList(stgSchemaKey);

    if (rawColumns.length === 0 || stgColumns.length === 0) {
      Logger.log(`[ERROR] Khong tim thay khai bao Schema hop le cho ${rawSchemaKey} hoac ${stgSchemaKey}`);
      return 0;
    }

    // Map col_key -> 0-based index tren mang du lieu tho RAW
    const rawColIndexMap = {};
    rawColumns.forEach(col => {
      if (col.col_key) {
        rawColIndexMap[col.col_key.toLowerCase()] = col.col_index;
      }
    });

    // Sap xep cac cot STG theo thu tu col_index tang dan
    const sortedStgColumns = stgColumns.sort((a, b) => a.col_index - b.col_index);

    const mapDict = this._buildMapRulesDictionary();
    const ucDict = this._buildUnitConversionDictionary();

    // Chuẩn hóa bộ lọc: { col_key: Set([val1, val2]) }
    const normalizedFilters = {};
    if (filters && typeof filters === 'object') {
      Object.keys(filters).forEach(key => {
        const cleanKey = String(key).trim().toLowerCase();
        const val = filters[key];
        if (Array.isArray(val)) {
          normalizedFilters[cleanKey] = new Set(val.map(v => String(v).trim()));
        } else if (val !== null && val !== undefined) {
          normalizedFilters[cleanKey] = new Set([String(val).trim()]);
        }
      });
    }

    const stgRows = [];

    const getRawVal = (row, colKey) => {
      const idx = rawColIndexMap[String(colKey).toLowerCase()];
      return (idx !== undefined && idx !== -1 && row[idx] !== undefined && row[idx] !== null) ? row[idx] : "";
    };

    const parseNum = (val) => {
      if (typeof val === 'number') return isNaN(val) ? 0 : val;
      if (!val) return 0;
      const cleanStr = String(val).replace(/,/g, '').trim();
      const num = Number(cleanStr);
      return isNaN(num) ? 0 : num;
    };

    for (let i = 1; i < rawRows.length; i++) {
      const r = rawRows[i];

      const invCode = String(getRawVal(r, "invoice_code")).trim();
      if (!invCode) continue;

      // KIEM TRA DIEU KIEN LOC (FILTERS)
      let passFilter = true;
      for (const filterColKey in normalizedFilters) {
        const rawVal = String(getRawVal(r, filterColKey) || "").trim();
        const allowedValues = normalizedFilters[filterColKey];
        if (!allowedValues.has(rawVal)) {
          passFilter = false;
          break;
        }
      }
      if (!passFilter) continue;

      const period    = String(getRawVal(r, "period")).trim();
      const invDate   = getRawVal(r, "invoice_date");
      const lineNo    = String(getRawVal(r, "line_no")).trim();
      const rawName   = String(getRawVal(r, "raw_name")).trim();
      const unit      = String(getRawVal(r, "unit")).trim();
      const taxRate   = parseNum(getRawVal(r, "tax_rate"));
      const qty       = parseNum(getRawVal(r, "quantity"));
      const price     = parseNum(getRawVal(r, "price"));
      
      let amount      = parseNum(getRawVal(r, "amount"));
      if (amount === 0 && (qty !== 0 || price !== 0)) {
        amount = qty * price;
      }
      const taxAmount = parseNum(getRawVal(r, "tax_amount"));

      const mapData = mapDict[rawName] || { itemName: rawName, itemCode: "" };
      const ucKey   = [mapData.itemCode, unit.toLowerCase()].join(this.KEY_DELIMITER);
      const ucData  = ucDict[ucKey] || { baseUnit: unit, factor: 1 };

      const baseQty   = qty * ucData.factor;
      const basePrice = ucData.factor !== 0 ? price / ucData.factor : price;

      const computedValues = {
        period:            period,
        invoice_code:      invCode,
        invoice_date:      invDate,
        line_no:           lineNo,
        raw_name:          rawName,
        item_name:         mapData.itemName,
        item_code:         mapData.itemCode,
        tax_rate:          taxRate,
        unit:              unit,
        quantity:          qty,
        price:             price,
        amount:            amount,
        tax_amount:        taxAmount,
        base_unit:         ucData.baseUnit,
        conversion_factor: ucData.factor,
        base_qty:          baseQty,
        base_price:        basePrice
      };

      // Projecting theo SCHEMA dau ra
      const projectedStgRow = sortedStgColumns.map(colDef => {
        const colKeyClean = String(colDef.col_key || "").trim().toLowerCase();
        
        if (computedValues.hasOwnProperty(colKeyClean)) {
          const cVal = computedValues[colKeyClean];
          return (cVal !== undefined && cVal !== null) ? cVal : "";
        }
        
        const directRawVal = getRawVal(r, colKeyClean);
        return directRawVal !== "" ? directRawVal : "";
      });

      stgRows.push(projectedStgRow);
    }

    if (stgRows.length > 0) {
      const targetKeys = (Array.isArray(primaryKeys) && primaryKeys.length > 0) ? primaryKeys : ["invoice_code", "line_no"];
      this.tableRepo.upsertRowsByTableName(stgSchemaKey, stgRows, targetKeys);
    }

    return stgRows.length;
  }

  applyAutoMapNamesToMapRules(sourceGroup = "INT") {
    const targetGrp = this._normalizeSourceGroup(sourceGroup);
    
    const mapInfo = this.tableRepo.getDataByTableName("MAP_RULE");
    const mapRows = mapInfo ? mapInfo.values : [];
    if (!mapRows || mapRows.length <= 1) return 0;

    const grpIdx = this._getColIndex("MAP_RULE", "source_grp");
    const rawNameIdx = this._getColIndex("MAP_RULE", "raw_name");
    const itemNameIdx = this._getColIndex("MAP_RULE", "item_name");

    if (grpIdx === -1 || rawNameIdx === -1 || itemNameIdx === -1) {
      Logger.log("[ERROR] Lỗi Schema: Không xác định đủ col_index trong MAP_RULE.");
      return 0;
    }

    const autoRules = this._loadAutoMapRulesCache(targetGrp);
    if (autoRules.length === 0) return 0;

    let updatedCount = 0;

    for (let i = 1; i < mapRows.length; i++) {
      const row = mapRows[i];
      const rawGrp = String(row[grpIdx] || "").trim();
      const rowGrp = this._normalizeSourceGroup(rawGrp);
      const rawName = String(row[rawNameIdx] || "").replace(/\u00A0/g, " ").trim();
      let currentItemName = row[itemNameIdx] !== undefined && row[itemNameIdx] !== null ? String(row[itemNameIdx]).trim() : "";

      if (rowGrp === targetGrp && rawName) {
        const matchedRule = this._findMatchedAutoRule(rawName, autoRules);
        if (matchedRule) {
          const newTargetName = matchedRule.targetItemName;
          if (currentItemName !== newTargetName) {
            row[itemNameIdx] = newTargetName;
            updatedCount++;
          }
        }
      }
    }

    if (updatedCount > 0) {
      this.tableRepo.updateTableData("MAP_RULE", mapRows);
      Logger.log(`[MAP_RULE] Đã cập nhật lại ${updatedCount} tên gợi ý mới qua TableRepository.`);
    }

    return updatedCount;
  }

  generateItemCodesForMapRules(sourceGroup = "INT") {
    const targetGrp = this._normalizeSourceGroup(sourceGroup);
    
    const mapInfo = this.tableRepo.getDataByTableName("MAP_RULE");
    const mapRows = mapInfo ? mapInfo.values : [];
    if (!mapRows || mapRows.length <= 1) return 0;

    const grpIdx = this._getColIndex("MAP_RULE", "source_grp");
    const rawNameIdx = this._getColIndex("MAP_RULE", "raw_name");
    const itemNameIdx = this._getColIndex("MAP_RULE", "item_name");
    const itemCodeIdx = this._getColIndex("MAP_RULE", "item_code");

    if (grpIdx === -1 || rawNameIdx === -1 || itemNameIdx === -1 || itemCodeIdx === -1) {
      Logger.log("[ERROR] Lỗi Schema: Không xác định đủ col_index trong schema MAP_RULE.");
      return 0;
    }

    let updatedCount = 0;

    for (let i = 1; i < mapRows.length; i++) {
      const row = mapRows[i];
      const rawGrp = String(row[grpIdx] || "").trim();
      const rowGrp = this._normalizeSourceGroup(rawGrp);
      const itemName = String(row[itemNameIdx] || "").trim();
      let currentItemCode = String(row[itemCodeIdx] || "").trim();

      if (rowGrp === targetGrp && itemName) {
        const newCode = this._generateItemCode(targetGrp, itemName);
        if (newCode !== currentItemCode) {
          row[itemCodeIdx] = newCode;
          updatedCount++;
        }
      }
    }

    if (updatedCount > 0) {
      this.tableRepo.updateTableData("MAP_RULE", mapRows);
      Logger.log(`[MAP_RULE] Đã sinh lại và cập nhật thành công ${updatedCount} mã SKU qua TableRepository.`);
    }

    return updatedCount;
  }

  syncMissingUnitConversions(sourceGroup = "INT") {
    const sysConfig = this._getSystemConfigs();
    const targetGrp = this._normalizeSourceGroup(sourceGroup);

    const ucGrpIdx      = this._getColIndex("UNIT_CONVERSION", "source_grp");
    const ucCodeIdx     = this._getColIndex("UNIT_CONVERSION", "item_code");
    const ucAltUnitIdx  = this._getColIndex("UNIT_CONVERSION", "alt_unit");
    const ucRawKeyIdx   = this._getColIndex("UNIT_CONVERSION", "raw_keyword");
    const ucBaseUnitIdx = this._getColIndex("UNIT_CONVERSION", "base_unit");
    const ucFactorIdx   = this._getColIndex("UNIT_CONVERSION", "conversion_factor");

    if (ucGrpIdx === -1 || ucCodeIdx === -1 || ucAltUnitIdx === -1 || ucBaseUnitIdx === -1) {
      Logger.log("[ERROR] Khai báo cột trong SCHEMA cho UNIT_CONVERSION bị thiếu.");
      return 0;
    }

    const rawSchemaKey = sysConfig.rawSchemaMap[targetGrp] || "RAW_PO_INVOICE";
    const rawInfo = this.tableRepo.getDataByTableName(rawSchemaKey);
    const rawRows = rawInfo ? rawInfo.values : [];
    if (!rawRows || rawRows.length <= 1) return 0;

    const imInfo = this.tableRepo.getDataByTableName("ITEM_MASTER");
    const imRows = imInfo ? imInfo.values : [];
    const imBaseUnitMap = {};
    if (imRows && imRows.length > 1) {
      const imCodeIdx = this._getColIndex("ITEM_MASTER", "item_code");
      const imBaseUnitIdx = this._getColIndex("ITEM_MASTER", "base_unit");
      for (let i = 1; i < imRows.length; i++) {
        const code = String(imRows[i][imCodeIdx] || "").trim();
        const bUnit = String(imRows[i][imBaseUnitIdx] || "").trim().toLowerCase();
        if (code && bUnit) imBaseUnitMap[code] = bUnit;
      }
    }

    const mapInfo = this.tableRepo.getDataByTableName("MAP_RULE");
    const mapRows = mapInfo ? mapInfo.values : [];
    const mapRawToCode = {};
    if (mapRows && mapRows.length > 1) {
      const mapRawIdx = this._getColIndex("MAP_RULE", "raw_name");
      const mapCodeIdx = this._getColIndex("MAP_RULE", "item_code");
      for (let i = 1; i < mapRows.length; i++) {
        const rName = String(mapRows[i][mapRawIdx] || "").trim();
        const iCode = String(mapRows[i][mapCodeIdx] || "").trim();
        if (rName && iCode) mapRawToCode[rName] = iCode;
      }
    }

    const ucInfo = this.tableRepo.getDataByTableName("UNIT_CONVERSION");
    const ucRows = ucInfo ? ucInfo.values : [];
    
    const existingUCMap = {};
    if (ucRows && ucRows.length > 1) {
      for (let i = 1; i < ucRows.length; i++) {
        const grp = this._normalizeSourceGroup(ucRows[i][ucGrpIdx]);
        const code = String(ucRows[i][ucCodeIdx] || "").trim();
        const altUnit = String(ucRows[i][ucAltUnitIdx] || "").trim().toLowerCase();
        if (code && altUnit) {
          const ucCompositeKey = [grp, code, altUnit].join(this.KEY_DELIMITER);
          existingUCMap[ucCompositeKey] = ucRows[i];
        }
      }
    }

    const rawNameIdx = this._getColIndex(rawSchemaKey, "raw_name");
    const rawCodeIdx = this._getColIndex(rawSchemaKey, "item_code");
    const rawUnitIdx = this._getColIndex(rawSchemaKey, "unit");

    if (rawUnitIdx === -1) return 0;

    const rowsToUpsert = [];
    const processedKeys = new Set();

    for (let i = 1; i < rawRows.length; i++) {
      let itemCode = rawCodeIdx !== -1 ? String(rawRows[i][rawCodeIdx] || "").trim() : "";
      const rawName = rawNameIdx !== -1 ? String(rawRows[i][rawNameIdx] || "").trim() : "";
      const altUnit = String(rawRows[i][rawUnitIdx] || "").trim();

      if (!itemCode && rawName && mapRawToCode[rawName]) {
        itemCode = mapRawToCode[rawName];
      }

      if (itemCode && altUnit) {
        const baseUnit = (imBaseUnitMap[itemCode] && imBaseUnitMap[itemCode].length > 0) 
          ? imBaseUnitMap[itemCode] 
          : altUnit.toLowerCase();

        const compositeKey = [targetGrp, itemCode, altUnit.toLowerCase()].join(this.KEY_DELIMITER);
        
        if (processedKeys.has(compositeKey)) continue;

        let targetRow = existingUCMap[compositeKey];

        if (targetRow) {
          const currentBaseUnit = String(targetRow[ucBaseUnitIdx] || "").trim();
          if (!currentBaseUnit) {
            const updatedRow = [...targetRow];
            updatedRow[ucBaseUnitIdx] = baseUnit;
            rowsToUpsert.push(updatedRow);
            processedKeys.add(compositeKey);
          }
        } else {
          const maxCols = Math.max(ucGrpIdx, ucCodeIdx, ucAltUnitIdx, ucRawKeyIdx, ucBaseUnitIdx, ucFactorIdx) + 1;
          const newRow = new Array(maxCols).fill("");
          newRow[ucGrpIdx]      = targetGrp;
          newRow[ucCodeIdx]     = itemCode;
          newRow[ucAltUnitIdx]  = altUnit;
          newRow[ucRawKeyIdx]   = altUnit;
          newRow[ucBaseUnitIdx] = baseUnit;
          newRow[ucFactorIdx]   = 1;

          rowsToUpsert.push(newRow);
          processedKeys.add(compositeKey);
        }
      }
    }

    if (rowsToUpsert.length > 0) {
      this.tableRepo.upsertRowsByTableName("UNIT_CONVERSION", rowsToUpsert, ["source_grp", "item_code", "alt_unit"]);
      Logger.log(`[UC SYNC] Đã đồng bộ ${rowsToUpsert.length} dòng vào UNIT_CONVERSION qua TableRepository.`);
    }

    return rowsToUpsert.length;
  }

  /**
   * Bootstrap dữ liệu từ RAW/MAP_RULE sang ITEM_MASTER
   */
  syncItemMasterFromMapRules(sourceGroup = "PO") {
    const sysConfig = this._getSystemConfigs();
    const targetGrp = this._normalizeSourceGroup(sourceGroup);
    const rawSchemaKey = sysConfig.rawSchemaMap[targetGrp] || "RAW_PO_INVOICE";

    // 1. Đọc MAP_RULE
    const mapInfo = this.tableRepo.getDataByTableName("MAP_RULE");
    const mapRows = mapInfo ? mapInfo.values : [];
    if (!mapRows || mapRows.length <= 1) return 0;

    const mapGrpIdx  = this._getColIndex("MAP_RULE", "source_grp");
    const mapRawIdx  = this._getColIndex("MAP_RULE", "raw_name");
    const mapNameIdx = this._getColIndex("MAP_RULE", "item_name");
    const mapCodeIdx = this._getColIndex("MAP_RULE", "item_code");

    // 2. Tra cứu unit gốc từ RAW để làm base_unit mặc định
    const rawInfo = this.tableRepo.getDataByTableName(rawSchemaKey);
    const rawRows = rawInfo ? rawInfo.values : [];
    const rawNameIdx = this._getColIndex(rawSchemaKey, "raw_name");
    const rawUnitIdx = this._getColIndex(rawSchemaKey, "unit");

    const rawNameToUnitMap = {};
    if (rawRows && rawRows.length > 1 && rawNameIdx !== -1 && rawUnitIdx !== -1) {
      for (let i = 1; i < rawRows.length; i++) {
        const rName = String(rawRows[i][rawNameIdx] || "").trim();
        const rUnit = String(rawRows[i][rawUnitIdx] || "").trim();
        if (rName && rUnit && !rawNameToUnitMap[rName]) {
          rawNameToUnitMap[rName] = rUnit;
        }
      }
    }

    // 3. Đọc dữ liệu ITEM_MASTER hiện tại
    const imInfo = this.tableRepo.getDataByTableName("ITEM_MASTER");
    const imRows = imInfo ? imInfo.values : [];
    const existingImCodes = new Set();

    const imCodeIdx       = this._getColIndex("ITEM_MASTER", "item_code");
    const imGrpIdx        = this._getColIndex("ITEM_MASTER", "source_grp");
    const imNameIdx       = this._getColIndex("ITEM_MASTER", "item_name");
    const imBaseUnitIdx   = this._getColIndex("ITEM_MASTER", "base_unit");
    const imIngrCodeIdx   = this._getColIndex("ITEM_MASTER", "ingredient_code");
    const imStgFactorIdx  = this._getColIndex("ITEM_MASTER", "stg_factor_to_base");
    const imItemTypeIdx   = this._getColIndex("ITEM_MASTER", "item_type");

    if (imRows && imRows.length > 1 && imCodeIdx !== -1) {
      for (let i = 1; i < imRows.length; i++) {
        const code = String(imRows[i][imCodeIdx] || "").trim();
        if (code) existingImCodes.add(code);
      }
    }

    const newImRows = [];
    const processedCodes = new Set();

    // Loại mặt hàng & ĐVT mặc định lấy từ SysConfigService
    const defaultItemType = targetGrp === "INT" ? sysConfig.itemTypeInt : sysConfig.itemTypeOut;
    const fallbackUnit = sysConfig.defaultUnit || "pcs";

    for (let i = 1; i < mapRows.length; i++) {
      const rowGrp   = this._normalizeSourceGroup(mapRows[i][mapGrpIdx]);
      const rawName  = String(mapRows[i][mapRawIdx] || "").trim();
      const itemName = String(mapRows[i][mapNameIdx] || "").trim();
      const itemCode = String(mapRows[i][mapCodeIdx] || "").trim();

      if (rowGrp === targetGrp && itemCode && !existingImCodes.has(itemCode) && !processedCodes.has(itemCode)) {
        const defaultBaseUnit = rawNameToUnitMap[rawName] || fallbackUnit;
        
        // Build dòng mới dựa theo schema ITEM_MASTER
        const maxCols = Math.max(imCodeIdx, imGrpIdx, imNameIdx, imBaseUnitIdx, imIngrCodeIdx, imStgFactorIdx, imItemTypeIdx) + 1;
        const newRow = new Array(maxCols).fill("");

        if (imCodeIdx !== -1)      newRow[imCodeIdx]      = itemCode;
        if (imGrpIdx !== -1)       newRow[imGrpIdx]       = targetGrp;
        if (imNameIdx !== -1)      newRow[imNameIdx]      = itemName || rawName;
        if (imBaseUnitIdx !== -1)  newRow[imBaseUnitIdx]  = defaultBaseUnit.toLowerCase();
        if (imIngrCodeIdx !== -1)  newRow[imIngrCodeIdx]  = "";
        if (imStgFactorIdx !== -1) newRow[imStgFactorIdx] = 1;
        if (imItemTypeIdx !== -1)  newRow[imItemTypeIdx]  = defaultItemType;

        newImRows.push(newRow);
        processedCodes.add(itemCode);
      }
    }

    if (newImRows.length > 0) {
      this.tableRepo.upsertRowsByTableName("ITEM_MASTER", newImRows, ["item_code"]);
      Logger.log(`[ITEM_MASTER] Đã đồng bộ thêm mới ${newImRows.length} mã mặt hàng vào ITEM_MASTER (${targetGrp}).`);
    }

    return newImRows.length;
  }

  /**
   * TỰ ĐỘNG MAP INGREDIENT_CODE CHO ITEM_MASTER DỰA TRÊN AUTO_INGREDIENT_RULE
   * Cập nhật trực tiếp vào bảng ITEM_MASTER hiện có (Update in-place)
   * 
   * @param {string} sourceGroup - "PO" hoặc "SO"
   * @returns {number} Số lượng dòng trong ITEM_MASTER được cập nhật
   */
  applyAutoIngredientCodesToItemMaster(sourceGroup = "PO") {
    const targetGrp = this._normalizeSourceGroup(sourceGroup);

    // 1. Lấy dữ liệu bảng ITEM_MASTER và AUTO_INGREDIENT_RULE
    const itemMasterInfo = this.tableRepo.getDataByTableName("ITEM_MASTER");
    const autoRulesInfo  = this.tableRepo.getDataByTableName("AUTO_INGREDIENT_RULE");

    const itemRows = itemMasterInfo ? itemMasterInfo.values : [];
    const ruleRows = autoRulesInfo ? autoRulesInfo.values : [];

    if (!itemRows || itemRows.length <= 1 || !ruleRows || ruleRows.length <= 1) return 0;

    // 2. Lấy vị trí cột theo Schema
    const idxItemCode   = this._getColIndex("ITEM_MASTER", "item_code");
    const idxSourceGrp  = this._getColIndex("ITEM_MASTER", "source_grp");
    const idxItemName   = this._getColIndex("ITEM_MASTER", "item_name");
    const idxIngredient = this._getColIndex("ITEM_MASTER", "ingredient_code");

    const idxRuleSource = this._getColIndex("AUTO_INGREDIENT_RULE", "source_grp");
    const idxRuleKw     = this._getColIndex("AUTO_INGREDIENT_RULE", "keywords");
    const idxRuleIng    = this._getColIndex("AUTO_INGREDIENT_RULE", "ingredient_code");

    if (idxItemCode === -1 || idxIngredient === -1 || idxRuleKw === -1 || idxRuleIng === -1) {
      Logger.log("[WARN] Không tìm thấy cột bắt buộc theo Schema của ITEM_MASTER hoặc AUTO_INGREDIENT_RULE.");
      return 0;
    }

    // 3. Phân tách danh sách quy tắc
    const parsedRules = [];
    for (let r = 1; r < ruleRows.length; r++) {
      const row = ruleRows[r];
      const rawRuleSource = idxRuleSource !== -1 ? String(row[idxRuleSource] || "").trim() : "";
      const rawKws         = String(row[idxRuleKw] || "").trim();
      const ingCode        = String(row[idxRuleIng] || "").trim();

      if (!rawKws || !ingCode) continue;

      if (rawRuleSource !== "" && rawRuleSource.toUpperCase() !== "ALL") {
        const ruleTargetGrp = this._normalizeSourceGroup(rawRuleSource);
        if (ruleTargetGrp !== targetGrp) continue;
      }

      const kwList = rawKws.split(',').map(k => k.trim()).filter(Boolean);

      kwList.forEach(kw => {
        parsedRules.push({
          pattern: kw,
          ingredientCode: ingCode
        });
      });
    }

    if (parsedRules.length === 0) return 0;

    // 4. Quét và CẬP NHẬT TRỰC TIẾP vào mảng itemRows (Update In-Place)
    let updatedCount = 0;

    for (let i = 1; i < itemRows.length; i++) {
      const row = itemRows[i];
      const itemCode   = String(row[idxItemCode] || "").trim();
      const itemName   = idxItemName !== -1 ? String(row[idxItemName] || "").trim() : "";
      const currentIng = String(row[idxIngredient] || "").trim();
      const rawRowSrc  = idxSourceGrp !== -1 ? String(row[idxSourceGrp] || "").trim() : "";

      // Không ghi đè nếu dòng đã có mã nguyên liệu sẵn
      if (currentIng !== "") continue;

      // Lọc đúng nhóm nguồn
      if (rawRowSrc !== "") {
        const rowTargetGrp = this._normalizeSourceGroup(rawRowSrc);
        if (rowTargetGrp !== targetGrp) continue;
      }

      let matchedIngCode = "";

      for (const rule of parsedRules) {
        const matchName = itemName && this._isWildcardMatch(itemName, rule.pattern);
        const matchCode = itemCode && this._isWildcardMatch(itemCode, rule.pattern);

        if (matchName || matchCode) {
          matchedIngCode = rule.ingredientCode;
          break;
        }
      }

      // Cập nhật ô dữ liệu ngay trên mảng itemRows
      if (matchedIngCode) {
        row[idxIngredient] = matchedIngCode;
        updatedCount++;
      }
    }

    // 5. Ghi đè lại toàn bộ bảng ITEM_MASTER nếu có sự thay đổi
    if (updatedCount > 0) {
      this.tableRepo.updateTableData("ITEM_MASTER", itemRows);
      Logger.log(`[AUTO INGREDIENT] Đã cập nhật thành công ${updatedCount} ingredient_code vào sheet ITEM_MASTER (${targetGrp}).`);
    }

    return updatedCount;
  }

  /**
   * CHẠY ĐỘC LẬP: TỰ ĐỘNG MAP INGREDIENT_CODE CHO ITEM_MASTER
   * Cho phép kích hoạt riêng từ Menu UI cho cả 2 nhóm INT và OUT
   * 
   * @param {string} sourceGroup - "PO", "SO", "INT", "OUT" hoặc "ALL"
   * @returns {number} Số lượng dòng được cập nhật thành công
   */
  applyAutoIngredientCodesOnly(sourceGroup = "ALL") {
    const isAll = String(sourceGroup || "").trim().toUpperCase() === "ALL";
    const targetGrp = isAll ? "ALL" : this._normalizeSourceGroup(sourceGroup);

    // 1. Nạp dữ liệu
    const itemMasterInfo = this.tableRepo.getDataByTableName("ITEM_MASTER");
    const autoRulesInfo  = this.tableRepo.getDataByTableName("AUTO_INGREDIENT_RULE");

    const itemRows = itemMasterInfo ? itemMasterInfo.values : [];
    const ruleRows = autoRulesInfo ? autoRulesInfo.values : [];

    if (!itemRows || itemRows.length <= 1 || !ruleRows || ruleRows.length <= 1) {
      Logger.log("[AUTO INGREDIENT] Bảng ITEM_MASTER hoặc AUTO_INGREDIENT_RULE không có dữ liệu.");
      return 0;
    }

    // 2. Lấy vị trí cột
    const idxItemCode   = this._getColIndex("ITEM_MASTER", "item_code");
    const idxSourceGrp  = this._getColIndex("ITEM_MASTER", "source_grp");
    const idxItemName   = this._getColIndex("ITEM_MASTER", "item_name");
    const idxIngredient = this._getColIndex("ITEM_MASTER", "ingredient_code");

    const idxRuleSource = this._getColIndex("AUTO_INGREDIENT_RULE", "source_grp");
    const idxRuleKw     = this._getColIndex("AUTO_INGREDIENT_RULE", "keywords");
    const idxRuleIng    = this._getColIndex("AUTO_INGREDIENT_RULE", "ingredient_code");

    if (idxItemCode === -1 || idxIngredient === -1 || idxRuleKw === -1 || idxRuleIng === -1) {
      Logger.log("[WARN] Thừa/thiếu cột theo Schema của ITEM_MASTER hoặc AUTO_INGREDIENT_RULE.");
      return 0;
    }

    // 3. Phân tách danh sách quy tắc
    const parsedRules = [];
    for (let r = 1; r < ruleRows.length; r++) {
      const row = ruleRows[r];
      const rawRuleSource = idxRuleSource !== -1 ? String(row[idxRuleSource] || "").trim() : "";
      const rawKws         = String(row[idxRuleKw] || "").trim();
      const ingCode        = String(row[idxRuleIng] || "").trim();

      if (!rawKws || !ingCode) continue;

      // Nếu chọn chạy cho 1 nhóm cụ thể, bỏ qua quy tắc không liên quan
      if (!isAll && rawRuleSource !== "" && rawRuleSource.toUpperCase() !== "ALL") {
        if (this._normalizeSourceGroup(rawRuleSource) !== targetGrp) continue;
      }

      const kwList = rawKws.split(',').map(k => k.trim()).filter(Boolean);
      kwList.forEach(kw => {
        parsedRules.push({
          sourceGrpPattern: rawRuleSource,
          pattern: kw,
          ingredientCode: ingCode
        });
      });
    }

    if (parsedRules.length === 0) {
      Logger.log("[AUTO INGREDIENT] Không tìm thấy quy tắc nào hợp lệ.");
      return 0;
    }

    // 4. Quét và cập nhật In-Place trên mảng dữ liệu
    let updatedCount = 0;

    for (let i = 1; i < itemRows.length; i++) {
      const row = itemRows[i];
      const itemCode   = String(row[idxItemCode] || "").trim();
      const itemName   = idxItemName !== -1 ? String(row[idxItemName] || "").trim() : "";
      const currentIng = String(row[idxIngredient] || "").trim();
      const rawRowSrc  = idxSourceGrp !== -1 ? String(row[idxSourceGrp] || "").trim() : "";

      // Không ghi đè dòng đã có mã nguyên liệu
      if (currentIng !== "") continue;

      // Lọc nhóm nguồn nếu không phải chạy ALL
      if (!isAll && rawRowSrc !== "") {
        if (this._normalizeSourceGroup(rawRowSrc) !== targetGrp) continue;
      }

      let matchedIngCode = "";

      for (const rule of parsedRules) {
        // Kiểm tra khớp thêm cả source_grp của dòng nếu rule chỉ định cụ thể
        if (rule.sourceGrpPattern && rule.sourceGrpPattern.toUpperCase() !== "ALL" && rawRowSrc) {
          if (this._normalizeSourceGroup(rule.sourceGrpPattern) !== this._normalizeSourceGroup(rawRowSrc)) {
            continue;
          }
        }

        const matchName = itemName && this._isWildcardMatch(itemName, rule.pattern);
        const matchCode = itemCode && this._isWildcardMatch(itemCode, rule.pattern);

        if (matchName || matchCode) {
          matchedIngCode = rule.ingredientCode;
          break;
        }
      }

      if (matchedIngCode) {
        row[idxIngredient] = matchedIngCode;
        updatedCount++;
      }
    }

    // 5. Cập nhật dữ liệu xuống bảng ITEM_MASTER
    if (updatedCount > 0) {
      this.tableRepo.updateTableData("ITEM_MASTER", itemRows);
      Logger.log(`[AUTO INGREDIENT MANUAL] Đã cập nhật ${updatedCount} mã nguyên liệu vào ITEM_MASTER (${targetGrp}).`);
    }

    return updatedCount;
  }

  /**
   * PRIVATE FUNCTION
   */

  
  _getSchemaColumnsList(schemaName) {
    const schemaMap = this._getSchemaMap();
    if (!schemaMap) return [];

    const schemaObj = schemaMap[schemaName] || schemaMap[schemaName.toLowerCase()];
    if (!schemaObj) return [];

    const columnsMap = schemaObj.columns || schemaObj;
    let list = [];

    if (Array.isArray(columnsMap)) {
      list = columnsMap.map(col => ({
        col_key: String(col.col_key || "").trim(),
        col_index: Number(col.col_index) - 1
      }));
    } else if (typeof columnsMap === 'object' && columnsMap !== null) {
      list = Object.keys(columnsMap).map(key => {
        const item = columnsMap[key];
        const isObj = typeof item === 'object' && item !== null;
        const colIdxOneBased = isObj ? (item.col_index !== undefined ? Number(item.col_index) : 999) : Number(item);
        return {
          col_key: isObj ? (item.col_key || key) : key,
          col_index: colIdxOneBased - 1
        };
      });
    }

    return list.filter(c => c.col_key !== "" && !isNaN(c.col_index) && c.col_index >= 0);
  }

  _buildMapRulesDictionary() {
    const mapInfo = this.tableRepo.getDataByTableName("MAP_RULE");
    const mapRows = mapInfo ? mapInfo.values : [];
    const dict = {};

    if (mapRows && mapRows.length > 1) {
      const rNameIdx = this._getColIndex("MAP_RULE", "raw_name");
      const iNameIdx = this._getColIndex("MAP_RULE", "item_name");
      const iCodeIdx = this._getColIndex("MAP_RULE", "item_code");

      if (rNameIdx !== -1) {
        for (let i = 1; i < mapRows.length; i++) {
          const rName = String(mapRows[i][rNameIdx] || "").trim();
          if (rName) {
            dict[rName] = {
              itemName: iNameIdx !== -1 ? String(mapRows[i][iNameIdx] || "").trim() : "",
              itemCode: iCodeIdx !== -1 ? String(mapRows[i][iCodeIdx] || "").trim() : ""
            };
          }
        }
      }
    }
    return dict;
  }

  _buildUnitConversionDictionary() {
    const ucInfo = this.tableRepo.getDataByTableName("UNIT_CONVERSION");
    const ucRows = ucInfo ? ucInfo.values : [];
    const dict = {};

    if (ucRows && ucRows.length > 1) {
      const cCodeIdx = this._getColIndex("UNIT_CONVERSION", "item_code");
      const cAltIdx  = this._getColIndex("UNIT_CONVERSION", "alt_unit");
      const cBaseIdx = this._getColIndex("UNIT_CONVERSION", "base_unit");
      const cFactIdx = this._getColIndex("UNIT_CONVERSION", "conversion_factor");

      if (cCodeIdx !== -1 && cAltIdx !== -1) {
        for (let i = 1; i < ucRows.length; i++) {
          const code = String(ucRows[i][cCodeIdx] || "").trim();
          const alt  = String(ucRows[i][cAltIdx] || "").trim().toLowerCase();
          if (code && alt) {
            const ucCompositeKey = [code, alt].join(this.KEY_DELIMITER);
            dict[ucCompositeKey] = {
              baseUnit: cBaseIdx !== -1 ? String(ucRows[i][cBaseIdx] || "").trim() : alt,
              factor: cFactIdx !== -1 ? (Number(ucRows[i][cFactIdx]) || 1) : 1
            };
          }
        }
      }
    }
    return dict;
  }

  _getColIndex(schemaName, colKey) {
    if (!this.schemaService) return -1;
    const schemaMap = this._getSchemaMap();

    const idx = this.schemaService.getColIndex(schemaMap, schemaName, colKey);
    if (idx !== undefined && idx !== null && !isNaN(idx)) {
      const numIdx = Number(idx);
      return numIdx > 0 ? numIdx - 1 : numIdx;
    }

    return -1;
  }

  _loadAutoMapRulesCache(sourceGroup) {
    const targetGrp = this._normalizeSourceGroup(sourceGroup);
    const rules = [];
    try {
      const schemaMap = this._getSchemaMap();
      const tableName = this.schemaService.getTableName(schemaMap, "AUTO_MAP_RULE");
      
      const tableInfo = this.tableRepo.getDataByTableName(tableName);
      const rows = tableInfo ? tableInfo.values : [];

      if (rows && rows.length > 1) {
        let grpIdx = this._getColIndex("AUTO_MAP_RULE", "source_grp");
        let kwIdx = this._getColIndex("AUTO_MAP_RULE", "keywords");
        let targetIdx = this._getColIndex("AUTO_MAP_RULE", "target_item_name");
        let priorityIdx = this._getColIndex("AUTO_MAP_RULE", "priority");

        if (grpIdx === -1) grpIdx = 0;
        if (kwIdx === -1) kwIdx = 1;
        if (targetIdx === -1) targetIdx = 2;
        if (priorityIdx === -1) priorityIdx = 3;

        for (let i = 1; i < rows.length; i++) {
          const row = rows[i];
          const rawGrp = String(row[grpIdx] || "").trim();
          const grp = this._normalizeSourceGroup(rawGrp);
          const keywordsStr = String(row[kwIdx] || "").trim();
          const targetItemName = String(row[targetIdx] || "").trim();
          const priority = Number(row[priorityIdx]) || 999;

          if ((grp === "ALL" || grp === targetGrp) && keywordsStr && targetItemName) {
            const kwList = keywordsStr.split(",").map(k => k.trim()).filter(Boolean);
            rules.push({
              keywords: kwList,
              targetItemName: targetItemName,
              priority: priority
            });
          }
        }
      }
    } catch (e) {
      Logger.log(`[WARNING] Lỗi nạp cache AUTO_MAP_RULE: ${e.message}`);
    }

    return rules.sort((a, b) => a.priority - b.priority);
  }

  _findMatchedAutoRule(rawName, rules) {
    if (!rawName) return null;
    const cleanRaw = String(rawName).trim();

    for (const rule of rules) {
      for (const kw of rule.keywords) {
        if (this._isWildcardMatch(cleanRaw, kw)) {
          return rule;
        }
      }
    }
    return null;
  }

  _isWildcardMatch(text, pattern) {
    if (!text || !pattern) return false;
    
    const cleanText = String(text).trim().normalize("NFC");
    const cleanPattern = String(pattern).trim().normalize("NFC");

    const escapedPattern = cleanPattern.replace(/([.+?^${}()|[\]\\])/g, "\\$1");
    const regexPattern = "^" + escapedPattern.replace(/\*/g, ".*") + "$";

    try {
      const regex = new RegExp(regexPattern, "iu");
      return regex.test(cleanText);
    } catch (e) {
      const regex = new RegExp(regexPattern, "i");
      return regex.test(cleanText.toLowerCase()) || regex.test(cleanText);
    }
  }

  _generateItemCode(sourceGroup, itemName) {
    if (!itemName) return "PENDING_MAPPING";
    const cleanCode = itemName
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[đĐ]/g, "d")
      .replace(/([^0-9a-z-\s])/gi, "")
      .trim()
      .replace(/\s+/g, "_")
      .toUpperCase();
    return `${sourceGroup}_${cleanCode}`;
  }
}
