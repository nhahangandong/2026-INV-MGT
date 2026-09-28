/**
 * [SERVICE] FactProcessingService.js
 * Xử lý tính toán và đổ dữ liệu từ STG sang FACT.
 * Sử dụng Dynamic Column Mapping & Index Projection từ SchemaService.
 */
class FactProcessingService {
  constructor(tableRepo, schemaService, sysConfigService = null, bomService = null) {
    if (!tableRepo || !schemaService) {
      throw new Error("[FactProcessingService] Thiếu Dependency bắt buộc (tableRepo, schemaService).");
    }
    this.tableRepo = tableRepo;
    this.schemaService = schemaService;
    this.sysConfigService = sysConfigService;
    this.bomService = bomService;
    this.KEY_DELIMITER = "___";
  }

  /**
   * Helper lấy 0-based index từ SchemaService (Chuẩn API 3 tham số)
   */
  _getColIndex(schemaName, colKey) {
    const schemaMap = (typeof this.schemaService.getSchemaMap === 'function') 
      ? this.schemaService.getSchemaMap() 
      : null;
    const col1Based = this.schemaService.getColIndex(schemaMap, schemaName, colKey);
    return col1Based > 0 ? col1Based - 1 : -1;
  }

  /**
   * Helper đọc cấu hình JSON từ SYSTEM_CONFIG
   */
  _getSysConfigJson(configKey, fallbackValue = {}) {
    if (!this.sysConfigService) return fallbackValue;
    try {
      let rawVal = null;
      if (typeof this.sysConfigService.getValue === 'function') {
        rawVal = this.sysConfigService.getValue(configKey);
      } else if (typeof this.sysConfigService.getConfig === 'function') {
        rawVal = this.sysConfigService.getConfig(configKey);
      }

      if (!rawVal) return fallbackValue;
      return (typeof rawVal === 'string') ? JSON.parse(rawVal) : rawVal;
    } catch (e) {
      Logger.log(`[WARN] Lỗi parse JSON cho configKey '${configKey}': ${e.message}`);
      return fallbackValue;
    }
  }

  /**
   * Dựng Dict tra cứu UNIT_CONVERSION
   */
  _buildUnitConversionDictionary(sourceGroup) {
    const ucInfo = this.tableRepo.getDataByTableName("UNIT_CONVERSION");
    const ucRows = ucInfo ? ucInfo.values : [];
    const dict = {};

    if (ucRows && ucRows.length > 1) {
      const grpIdx    = this._getColIndex("UNIT_CONVERSION", "source_grp");
      const codeIdx   = this._getColIndex("UNIT_CONVERSION", "item_code");
      const altIdx    = this._getColIndex("UNIT_CONVERSION", "alt_unit");
      const baseIdx   = this._getColIndex("UNIT_CONVERSION", "base_unit");
      const factorIdx = this._getColIndex("UNIT_CONVERSION", "conversion_factor");

      for (let i = 1; i < ucRows.length; i++) {
        const grp     = String(ucRows[i][grpIdx] || "").trim().toUpperCase();
        const code    = String(ucRows[i][codeIdx] || "").trim();
        const altUnit = String(ucRows[i][altIdx] || "").trim().toLowerCase();
        
        if ((grp === sourceGroup || grp === "PO" || grp === "INT" || grp === "ALL") && code && altUnit) {
          const key = [grp, code, altUnit].join(this.KEY_DELIMITER);
          dict[key] = {
            baseUnit: String(ucRows[i][baseIdx] || "").trim().toLowerCase(),
            factor:   Number(ucRows[i][factorIdx]) || 1
          };
        }
      }
    }
    return dict;
  }

  /**
   * Dựng Dict tra cứu ITEM_MASTER
   */
  _buildItemMasterDictionary() {
    const imInfo = this.tableRepo.getDataByTableName("ITEM_MASTER");
    const imRows = imInfo ? imInfo.values : [];
    const dict = {};

    if (imRows && imRows.length > 1) {
      const codeIdx   = this._getColIndex("ITEM_MASTER", "item_code");
      const baseIdx   = this._getColIndex("ITEM_MASTER", "base_unit");
      const ingIdx    = this._getColIndex("ITEM_MASTER", "ingredient_code");
      const factorIdx = this._getColIndex("ITEM_MASTER", "stg_factor_to_base");

      for (let i = 1; i < imRows.length; i++) {
        const code = String(imRows[i][codeIdx] || "").trim();
        if (code) {
          dict[code] = {
            baseUnit:       String(imRows[i][baseIdx] || "").trim().toLowerCase(),
            ingredientCode: ingIdx !== -1 ? String(imRows[i][ingIdx] || "").trim() : "",
            stgFactor:      factorIdx !== -1 ? (Number(imRows[i][factorIdx]) || 1) : 1
          };
        }
      }
    }
    return dict;
  }

  /**
   * Tra cứu hệ số quy đổi: UNIT_CONVERSION First -> ITEM_MASTER Fallback -> Default 1
   */
  _resolveConversionFactorAndBaseUnit(sourceGrp, itemCode, stgUnit, ucDict, imDict) {
    const cleanGrp  = String(sourceGrp || "INT").trim().toUpperCase();
    const cleanCode = String(itemCode || "").trim();
    const cleanUnit = String(stgUnit || "").trim().toLowerCase();

    const imInfo = imDict[cleanCode] || {};
    let baseUnit = imInfo.baseUnit || cleanUnit;
    let factor = 1;

    // 1. Kiểm tra UNIT_CONVERSION
    const ucKey = [cleanGrp, cleanCode, cleanUnit].join(this.KEY_DELIMITER);
    const ucInfo = ucDict[ucKey];

    if (ucInfo && Number(ucInfo.factor) > 0) {
      factor = Number(ucInfo.factor);
      if (ucInfo.baseUnit) baseUnit = ucInfo.baseUnit;
    } 
    // 2. Fallback sang ITEM_MASTER
    else if (imInfo.stgFactor && Number(imInfo.stgFactor) > 0) {
      factor = Number(imInfo.stgFactor);
    }

    return { factor, baseUnit };
  }

  /**
   * BƯỚC THỰC THI: Tổng hợp Fact Inbound từ STG_PO_INVOICE sang FACT_INBOUND
   */
  processFactInbound(periodFilter = null) {
    const stgSchemaKey = "STG_PO_INVOICE";
    const factSchemaKey = "FACT_INBOUND";

    // 1. Cấu hình Primary Keys từ SYSTEM_CONFIG
    const primaryKeys = this._getSysConfigJson("FACT_INBOUND_PRIMARY_KEYS", ["doc_code", "line_no"]);

    // 2. Nạp dữ liệu Staging
    const stgInfo = this.tableRepo.getDataByTableName(stgSchemaKey);
    const stgRows = stgInfo ? stgInfo.values : [];
    if (!stgRows || stgRows.length <= 1) return 0;

    // 3. Khởi tạo Dictionaries & Indices
    const ucDict = this._buildUnitConversionDictionary("INT");
    const imDict = this._buildItemMasterDictionary();

    const idxSTG = {
      period:   this._getColIndex(stgSchemaKey, "period"),
      invDate:  this._getColIndex(stgSchemaKey, "invoice_date"),
      invCode:  this._getColIndex(stgSchemaKey, "invoice_code"),
      lineNo:   this._getColIndex(stgSchemaKey, "line_no"),
      itemCode: this._getColIndex(stgSchemaKey, "item_code"),
      unit:     this._getColIndex(stgSchemaKey, "unit"),
      qty:      this._getColIndex(stgSchemaKey, "quantity"),
      price:    this._getColIndex(stgSchemaKey, "price"),
      amount:   this._getColIndex(stgSchemaKey, "amount"),
      taxAmt:   this._getColIndex(stgSchemaKey, "tax_amount")
    };

    const parseNum = (val) => {
      if (typeof val === 'number') return isNaN(val) ? 0 : val;
      if (!val) return 0;
      const num = Number(String(val).replace(/,/g, '').trim());
      return isNaN(num) ? 0 : num;
    };

    // Nạp định nghĩa Cột của FACT_INBOUND từ Schema
    const schemaMap = this.schemaService.getSchemaMap();
    const factSchema = schemaMap[factSchemaKey] || schemaMap[factSchemaKey.toLowerCase()];
    const colDefs = factSchema ? (factSchema.columns || factSchema) : {};

    const factRows = [];

    // 4. Duyệt các dòng Staging
    for (let i = 1; i < stgRows.length; i++) {
      const r = stgRows[i];

      const period = idxSTG.period !== -1 ? String(r[idxSTG.period] || "").trim() : "";
      if (periodFilter && period !== String(periodFilter).trim()) continue;

      const invCode = idxSTG.invCode !== -1 ? String(r[idxSTG.invCode] || "").trim() : "";
      if (!invCode) continue;

      const lineNo   = idxSTG.lineNo !== -1 ? String(r[idxSTG.lineNo] || "").trim() : "";
      const invDate  = idxSTG.invDate !== -1 ? r[idxSTG.invDate] : "";
      const itemCode = idxSTG.itemCode !== -1 ? String(r[idxSTG.itemCode] || "").trim() : "";
      const stgUnit  = idxSTG.unit !== -1 ? String(r[idxSTG.unit] || "").trim() : "";
      
      const qty    = parseNum(idxSTG.qty !== -1 ? r[idxSTG.qty] : 0);
      const price  = parseNum(idxSTG.price !== -1 ? r[idxSTG.price] : 0);
      const amount = parseNum(idxSTG.amount !== -1 ? r[idxSTG.amount] : 0);
      const taxAmt = parseNum(idxSTG.taxAmt !== -1 ? r[idxSTG.taxAmt] : 0);

      // Tra cứu Nguyên liệu gốc & Hệ số
      const imInfo  = imDict[itemCode] || {};
      const ingCode = imInfo.ingredientCode || itemCode;

      const { factor, baseUnit } = this._resolveConversionFactorAndBaseUnit("INT", itemCode, stgUnit, ucDict, imDict);

      const baseQty     = qty * factor;
      const basePrice   = factor !== 0 ? price / factor : price;
      const totalAmount = amount + taxAmt;

      // Map dữ liệu theo đúng col_key của Schema FACT_INBOUND
      const computedFactObj = {
        "period":          period,
        "trans_date":      invDate,
        "doc_code":        invCode,
        "line_no":         lineNo,
        "item_code":       itemCode,
        "ingredient_code": ingCode,
        "base_unit":       baseUnit,
        "base_qty":        baseQty,
        "base_price":      basePrice,
        "amount":          amount,
        "tax_amount":      taxAmt,
        "total_amount":    totalAmount
      };

      // 5. Dynamic Projection: Dựng mảng kết quả ĐỘNG hoàn toàn theo col_index trong Schema
      const projectedRow = [];
      Object.keys(colDefs).forEach(colKey => {
        const colInfo = colDefs[colKey];
        const idxZeroBased = (typeof colInfo === 'object' && colInfo.col_index !== undefined)
          ? Number(colInfo.col_index) - 1
          : Number(colInfo) - 1;

        if (idxZeroBased >= 0) {
          const val = computedFactObj.hasOwnProperty(colKey) ? computedFactObj[colKey] : "";
          projectedRow[idxZeroBased] = (val !== undefined && val !== null) ? val : "";
        }
      });

      factRows.push(projectedRow);
    }

    // 6. Lưu xuống bảng FACT_INBOUND via DAL Repository
    if (factRows.length > 0) {
      this.tableRepo.upsertRowsByTableName(factSchemaKey, factRows, primaryKeys);
      Logger.log(`[FACT INBOUND] Đã xử lý & ghi thành công ${factRows.length} dòng vào FACT_INBOUND.`);
    }

    return factRows.length;
  }

  /**
   * Tính lại Fact khi thông số UNIT_CONVERSION thay đổi
   */
  recalculateFactOnUnitConversionChange(sourceGroup = "ALL") {
    const isAll = String(sourceGroup || "").trim().toUpperCase() === "ALL";
    let total = 0;

    if (isAll || sourceGroup === "PO" || sourceGroup === "INT") {
      total += this.processFactInbound();
    }
    return total;
  }

  /**
   * Placeholder cho Fact Outbound (Sẽ mở rộng khi xử lý STG_SALES/POS)
   */
  processFactOutbound(periodFilter = null) {
    Logger.log("[FACT OUTBOUND] Chưa triển khai.");
    return 0;
  }
}
