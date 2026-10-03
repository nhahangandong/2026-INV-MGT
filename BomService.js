/**
 * [SERVICE] BomService.js - Dynamic Schema V2 (Empty Child Item Code on Bootstrap)
 */
class BomService {
  constructor(tableRepo, schemaService, configService = null) {
    if (!tableRepo || !schemaService) {
      throw new Error("[BomService] Thieu Dependency bat buoc (tableRepo, schemaService).");
    }
    this.tableRepo = tableRepo;
    this.schemaService = schemaService;
    this.configService = configService;
    this.KEY_DELIMITER = "___";
    this._cachedBomMap = null;
  }

  /**
   * Lấy Col Index (0-based) chuẩn V2 từ SchemaService
   */
  _getColIndex(schemaName, colKey) {
    const schemaMap = (typeof this.schemaService.getSchemaMap === 'function') 
      ? this.schemaService.getSchemaMap() 
      : null;
    const col1Based = this.schemaService.getColIndex(schemaMap, schemaName, colKey);
    return col1Based > 0 ? col1Based - 1 : -1;
  }

  _resolveTargetDate(timeInput) {
    if (!timeInput) return new Date();
    if (timeInput instanceof Date) return timeInput;

    const str = String(timeInput).trim();
    const cleanStr = str.replace(/[^0-9]/g, "");

    if (cleanStr.length === 6) {
      const year  = parseInt(cleanStr.substring(0, 4), 10);
      const month = parseInt(cleanStr.substring(4, 6), 10);
      return new Date(year, month, 0, 23, 59, 59);
    }

    const parsedDate = new Date(str);
    return isNaN(parsedDate.getTime()) ? new Date() : parsedDate;
  }

  _isDateWithinRange(targetDate, effFrom, effTo) {
    const parseToTimestamp = (d, defaultStr) => {
      if (!d) return new Date(defaultStr).getTime();
      if (d instanceof Date) return d.getTime();
      
      const str = String(d).trim().replace(/\//g, "-");
      const p = new Date(str);
      return isNaN(p.getTime()) ? new Date(defaultStr).getTime() : p.getTime();
    };

    const tTime = parseToTimestamp(targetDate, "2026-01-01");
    const fTime = parseToTimestamp(effFrom, "1900-01-01");
    const eTime = parseToTimestamp(effTo, "2099-12-31");

    return tTime >= fTime && tTime <= eTime;
  }

  /**
   * Khởi tạo danh mục BOM từ ITEM_MASTER
   * - KHÔNG tự động điền child_item_code (để trống "")
   */
  bootstrapBomFromItemMaster() {
    this.clearCache();
    const imInfo = this.tableRepo.getDataByTableName("ITEM_MASTER");
    const imRows = imInfo ? imInfo.values : [];
    if (!imRows || imRows.length <= 1) return 0;

    // 1. Lấy tham số cấu hình lọc từ ConfigService
    let allowedSourceGroups = [];
    let nonInventoryTypes = [];

    if (this.configService && typeof this.configService.getConfig === "function") {
      const rawGroups = this.configService.getConfig("BOM_PARENT_SOURCE_GROUPS") || "SO,OUT";
      allowedSourceGroups = rawGroups.split(",").map(s => s.trim().toUpperCase()).filter(Boolean);

      const rawNonInv = this.configService.getConfig("NON_INVENTORY_ITEM_TYPES") || "";
      nonInventoryTypes = rawNonInv.split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
    } else {
      allowedSourceGroups = ["SO", "OUT"];
    }

    // 2. Xác định vị trí cột động trong ITEM_MASTER theo Schema
    const idxItemCode   = this._getColIndex("ITEM_MASTER", "item_code");
    const idxUnit       = this._getColIndex("ITEM_MASTER", "base_unit");
    const idxSourceGrp  = this._getColIndex("ITEM_MASTER", "source_group");
    const idxItemType   = this._getColIndex("ITEM_MASTER", "item_type");

    // 3. Đọc dữ liệu BOM_RECIPE hiện tại để lấy danh sách PARENT đã tồn tại
    const bomInfo = this.tableRepo.getDataByTableName("BOM_RECIPE");
    const bomRows = bomInfo ? bomInfo.values : [];
    const existingParents = new Set();

    if (bomRows && bomRows.length > 1) {
      const idxParent = this._getColIndex("BOM_RECIPE", "parent_item_code");

      for (let r = 1; r < bomRows.length; r++) {
        const p = idxParent !== -1 ? String(bomRows[r][idxParent] || "").trim() : "";
        if (p) existingParents.add(p);
      }
    }

    const newBomRows = [];
    const primaryKeys = ["parent_item_code", "child_item_code"];

    // 4. Lấy Schema Definition của BOM_RECIPE để chiếu dữ liệu động
    const schemaMap = this.schemaService.getSchemaMap();
    const bomSchema = schemaMap["BOM_RECIPE"] || schemaMap["bom_recipe"];
    const colDefs = bomSchema ? (bomSchema.columns || bomSchema) : {};

    for (let r = 1; r < imRows.length; r++) {
      const parentCode = idxItemCode !== -1 ? String(imRows[r][idxItemCode] || "").trim() : "";
      if (!parentCode) continue;

      // QUY TẮC 1: Nếu mã Parent ĐÃ TỒN TẠI trong BOM_RECIPE -> BỎ QUA HOÀN TOÀN
      if (existingParents.has(parentCode)) {
        continue;
      }

      // QUY TẮC 2: Loại bỏ mặt hàng dịch vụ / chi phí / không theo dõi tồn kho
      const itemType = idxItemType !== -1 ? String(imRows[r][idxItemType] || "").trim().toUpperCase() : "";
      if (itemType && nonInventoryTypes.includes(itemType)) {
        continue;
      }

      // QUY TẮC 3: Kiểm tra nhóm nguồn thuộc BOM_PARENT_SOURCE_GROUPS
      let sourceGroup = idxSourceGrp !== -1 ? String(imRows[r][idxSourceGrp] || "").trim().toUpperCase() : "";
      if (!sourceGroup) {
        const prefix = parentCode.split("_")[0];
        sourceGroup = prefix ? prefix.toUpperCase() : "";
      }

      if (allowedSourceGroups.length > 0 && !allowedSourceGroups.includes(sourceGroup)) {
        continue;
      }

      const unit = idxUnit !== -1 ? String(imRows[r][idxUnit] || "").trim().toLowerCase() : "";
      
      // QUY TẮC MỚI: child_item_code ĐỂ TRỐNG ""
      const computedBomObj = {
        "parent_item_code": parentCode,
        "child_item_code": "", 
        "std_qty": 1,
        "unit": unit,
        "bom_level": 1,
        "is_leaf": true,
        "effective_from": "2026-01-01",
        "effective_to": "2099-12-31",
        "is_active": false,
        "note": "Auto bootstrap from ITEM_MASTER"
      };

      // Project mảng dòng dựa theo Schema Index thực tế
      const projectedRow = [];
      Object.keys(colDefs).forEach(colKey => {
        const colInfo = colDefs[colKey];
        const idxZeroBased = (typeof colInfo === 'object' && colInfo.col_index !== undefined)
          ? Number(colInfo.col_index) - 1
          : Number(colInfo) - 1;

        if (idxZeroBased >= 0) {
          const val = computedBomObj.hasOwnProperty(colKey) ? computedBomObj[colKey] : "";
          projectedRow[idxZeroBased] = (val !== undefined && val !== null) ? val : "";
        }
      });

      newBomRows.push(projectedRow);
      existingParents.add(parentCode);
    }

    if (newBomRows.length > 0) {
      this.tableRepo.upsertRowsByTableName("BOM_RECIPE", newBomRows, primaryKeys);
      Logger.log(`[BOM SERVICE] Đã khởi tạo mới ${newBomRows.length} bản ghi BOM vào BOM_RECIPE (child_item_code để trống).`);
    }

    return newBomRows.length;
  }

  clearCache() {
    this._cachedBomMap = null;
  }

  _loadEffectiveBomMap(targetDate) {
    if (this._cachedBomMap) {
      return this._cachedBomMap;
    }

    const bomInfo = this.tableRepo.getDataByTableName("BOM_RECIPE");
    const bomRows = bomInfo ? bomInfo.values : [];
    const bomMap = new Map();

    if (!bomRows || bomRows.length <= 1) {
      this._cachedBomMap = bomMap;
      return bomMap;
    }

    const idxParent = this._getColIndex("BOM_RECIPE", "parent_item_code");
    const idxChild  = this._getColIndex("BOM_RECIPE", "child_item_code");
    const idxQty    = this._getColIndex("BOM_RECIPE", "std_qty");
    const idxUnit   = this._getColIndex("BOM_RECIPE", "unit");
    const idxLevel  = this._getColIndex("BOM_RECIPE", "bom_level");
    const idxLeaf   = this._getColIndex("BOM_RECIPE", "is_leaf");
    const idxFrom   = this._getColIndex("BOM_RECIPE", "effective_from");
    const idxTo     = this._getColIndex("BOM_RECIPE", "effective_to");
    const idxActive = this._getColIndex("BOM_RECIPE", "is_active");

    for (let r = 1; r < bomRows.length; r++) {
      const row = bomRows[r];
      const parent = idxParent !== -1 ? String(row[idxParent] || "").trim() : "";
      const child  = idxChild !== -1 ? String(row[idxChild] || "").trim() : "";
      const qty    = idxQty !== -1 ? (Number(row[idxQty]) || 0) : 0;
      const unit   = idxUnit !== -1 ? String(row[idxUnit] || "").trim() : "";
      const level  = idxLevel !== -1 ? (Number(row[idxLevel]) || 1) : 1;
      
      const rawLeaf   = idxLeaf !== -1 ? row[idxLeaf] : true;
      const strLeaf   = String(rawLeaf || "").trim().toUpperCase();
      const isLeaf    = strLeaf === "TRUE" || strLeaf === "1" || rawLeaf === true;
      
      const rawActive = idxActive !== -1 ? row[idxActive] : true;
      const strActive = String(rawActive || "").trim().toUpperCase();
      const isActive  = strActive === "TRUE" || strActive === "1" || rawActive === true;

      if (!parent || !isActive) continue;

      const effFrom = idxFrom !== -1 ? row[idxFrom] : null;
      const effTo   = idxTo !== -1 ? row[idxTo] : null;

      if (this._isDateWithinRange(targetDate, effFrom, effTo)) {
        if (!bomMap.has(parent)) {
          bomMap.set(parent, []);
        }
        bomMap.get(parent).push({
          parentItemCode: parent,
          childItemCode: child,
          stdQty: qty,
          unit: unit,
          bomLevel: level,
          isLeaf: isLeaf
        });
      }
    }

    this._cachedBomMap = bomMap;
    return bomMap;
  }

  getBomComponents(parentCode, targetTime = new Date()) {
    const directRecipe = this.getDirectRecipe(parentCode, targetTime);
    if (directRecipe && directRecipe.length > 0) {
      return directRecipe;
    }
    return this.explodeBom(parentCode, 1, targetTime);
  }

  explodeBom(parentCode, parentQty = 1, targetTime = new Date()) {
    const targetDate = this._resolveTargetDate(targetTime);
    const bomMap = this._loadEffectiveBomMap(targetDate);
    const explodedResults = [];

    const recurse = (currentParent, currentQty, depth = 1) => {
      const children = bomMap.get(currentParent) || [];

      if (children.length === 0) return;

      for (const child of children) {
        if (!child.childItemCode) continue;

        const reqQty = currentQty * child.stdQty;

        if (child.isLeaf || !bomMap.has(child.childItemCode)) {
          explodedResults.push({
            parentItemCode: currentParent,
            childItemCode: child.childItemCode,
            child_item_code: child.childItemCode,
            stdQty: child.stdQty,
            std_qty: child.stdQty,
            totalQty: reqQty,
            unit: child.unit,
            bomLevel: child.bomLevel || depth,
            bom_level: child.bomLevel || depth,
            isLeaf: child.isLeaf
          });
        } else {
          recurse(child.childItemCode, reqQty, depth + 1);
        }
      }
    };

    recurse(String(parentCode || "").trim(), parentQty, 1);
    return explodedResults;
  }

  getDirectRecipe(parentCode, targetTime = new Date()) {
    const targetDate = this._resolveTargetDate(targetTime);
    const bomMap = this._loadEffectiveBomMap(targetDate);
    const cleanParent = String(parentCode || "").trim();
    const children = bomMap.get(cleanParent) || [];

    return children.filter(c => Boolean(c.childItemCode)).map(c => ({
      parentItemCode: cleanParent,
      childItemCode: c.childItemCode,
      child_item_code: c.childItemCode,
      stdQty: c.stdQty,
      std_qty: c.stdQty,
      totalQty: c.stdQty,
      unit: c.unit,
      bomLevel: c.bomLevel || 1,
      bom_level: c.bomLevel || 1,
      isLeaf: c.isLeaf
    }));
  }
}
