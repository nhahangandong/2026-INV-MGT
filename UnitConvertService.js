/**
 * Service quản lý quy đổi đơn vị tính nâng cao
 * Đồng bộ chuẩn 100% theo Schema UNIT_CONVERSION mới
 */
class UnitConvertService {
  constructor(tableRepo, schemaService) {
    this.tableRepo = tableRepo;
    this.schemaService = schemaService;
    this._conversionCache = null;
    this._itemMasterCache = null;
  }

  /**
   * Khởi tạo Cache dữ liệu cho UNIT_CONVERSION và ITEM_MASTER
   */
  _initCaches() {
    if (this._conversionCache && this._itemMasterCache) return;

    const schemaMap = this.schemaService.getSchemaMap();
    
    // 1. Cache bảng UNIT_CONVERSION
    const ucTableName = this.schemaService.getTableName(schemaMap, "UNIT_CONVERSION");
    const ucInfo = this.tableRepo.getDataByTableName(ucTableName);
    const ucRows = ucInfo ? ucInfo.values : [];
    
    this._conversionCache = [];
    if (ucRows && ucRows.length > 1) {
      const ucGrpIdx = this.schemaService.getColIndex("UNIT_CONVERSION", "source_grp");
      const ucItemCodeIdx = this.schemaService.getColIndex("UNIT_CONVERSION", "item_code");
      const ucAltUnitIdx = this.schemaService.getColIndex("UNIT_CONVERSION", "alt_unit");
      const ucKeywordIdx = this.schemaService.getColIndex("UNIT_CONVERSION", "raw_keyword");
      const ucBaseUnitIdx = this.schemaService.getColIndex("UNIT_CONVERSION", "base_unit");
      const ucFactorIdx = this.schemaService.getColIndex("UNIT_CONVERSION", "conversion_factor");

      for (let i = 1; i < ucRows.length; i++) {
        const row = ucRows[i];
        this._conversionCache.push({
          sourceGrp: String(ucGrpIdx !== -1 ? row[ucGrpIdx] : "INT").trim().toUpperCase(),
          itemCode: String(row[ucItemCodeIdx] || "").trim(),
          altUnit: String(row[ucAltUnitIdx] || "").trim().toLowerCase(),
          rawKeyword: String(ucKeywordIdx !== -1 ? row[ucKeywordIdx] : "").trim().toLowerCase(),
          baseUnit: String(row[ucBaseUnitIdx] || "").trim().toLowerCase(),
          conversionFactor: Number(row[ucFactorIdx]) || 1
        });
      }
    }

    // 2. Cache bảng ITEM_MASTER
    const imTableName = this.schemaService.getTableName(schemaMap, "ITEM_MASTER");
    const imInfo = this.tableRepo.getDataByTableName(imTableName);
    const imRows = imInfo ? imInfo.values : [];

    this._itemMasterCache = {};
    if (imRows && imRows.length > 1) {
      const imItemCodeIdx = this.schemaService.getColIndex("ITEM_MASTER", "item_code");
      const imBaseUnitIdx = this.schemaService.getColIndex("ITEM_MASTER", "base_unit");
      const imIngredientIdx = this.schemaService.getColIndex("ITEM_MASTER", "ingredient_code");
      const imFactorIdx = this.schemaService.getColIndex("ITEM_MASTER", "stg_factor_to_base");

      for (let i = 1; i < imRows.length; i++) {
        const row = imRows[i];
        const code = String(row[imItemCodeIdx] || "").trim();
        if (code) {
          this._itemMasterCache[code] = {
            baseUnit: String(row[imBaseUnitIdx] || "").trim().toLowerCase(),
            ingredientCode: String(row[imIngredientIdx] || "").trim(),
            stdFactorToBase: Number(row[imFactorIdx]) || 1
          };
        }
      }
    }
  }

  /**
   * Tra cứu Hệ số quy đổi (conversion_factor) ra đơn vị cơ sở
   * @param {string} sourceGroup - "INT" hoặc "OUT"
   * @param {string} itemCode - Mã item kho
   * @param {string} inputUnit - Đơn vị ghi nhận trên chứng từ (alt_unit)
   * @param {string} rawName - Tên nguyên bản chứng từ (dùng nếu cần khớp raw_keyword)
   */
  getConversionInfo(sourceGroup = "INT", itemCode = "", inputUnit = "", rawName = "") {
    this._initCaches();

    const targetGrp = String(sourceGroup || "INT").trim().toUpperCase();
    const normalizedCode = String(itemCode || "").trim();
    const normalizedUnit = String(inputUnit || "").trim().toLowerCase();
    const normalizedRawName = String(rawName || "").trim().toLowerCase();

    const itemMasterInfo = this._itemMasterCache[normalizedCode] || {
      baseUnit: "",
      ingredientCode: normalizedCode,
      stdFactorToBase: 1
    };

    // 1. Nếu đơn vị trùng với base_unit hoặc không truyền đơn vị -> Factor = 1
    if (!normalizedUnit || normalizedUnit === itemMasterInfo.baseUnit) {
      return {
        factor: 1,
        baseUnit: itemMasterInfo.baseUnit,
        ingredientCode: itemMasterInfo.ingredientCode
      };
    }

    // 2. Tra trong UNIT_CONVERSION theo bộ khóa (source_grp, item_code, alt_unit)
    const matchedRules = this._conversionCache.filter(
      rule => rule.sourceGrp === targetGrp && 
              rule.itemCode === normalizedCode && 
              rule.altUnit === normalizedUnit
    );

    if (matchedRules.length > 0) {
      // Ưu tiên khớp raw_keyword nếu chuỗi raw_name có chứa từ khóa
      if (normalizedRawName) {
        const kwMatch = matchedRules.find(
          rule => rule.rawKeyword && normalizedRawName.includes(rule.rawKeyword.replace(/\*/g, ""))
        );
        if (kwMatch) {
          return {
            factor: kwMatch.conversionFactor,
            baseUnit: kwMatch.baseUnit || itemMasterInfo.baseUnit,
            ingredientCode: itemMasterInfo.ingredientCode
          };
        }
      }
      return {
        factor: matchedRules[0].conversionFactor,
        baseUnit: matchedRules[0].baseUnit || itemMasterInfo.baseUnit,
        ingredientCode: itemMasterInfo.ingredientCode
      };
    }

    // 3. Fallback lấy hệ số mặc định stg_factor_to_base từ ITEM_MASTER
    return {
      factor: itemMasterInfo.stdFactorToBase,
      baseUnit: itemMasterInfo.baseUnit,
      ingredientCode: itemMasterInfo.ingredientCode
    };
  }
}
