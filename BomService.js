/**
 * [SERVICE] BomService.js - Optimized with In-Memory Cache
 */
class BomService {
  constructor(tableRepo, configService = null) {
    this.tableRepo = tableRepo;
    this.configService = configService;
    this.KEY_DELIMITER = "___";
    this._cachedBomMap = null; // Cache map để không re-query Sheet liên tục
  }

  _getColIdx(headerRow, colKey) {
    if (!headerRow) return -1;
    return headerRow.findIndex(cell => String(cell || "").trim().toLowerCase() === colKey.toLowerCase());
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

  bootstrapBomFromItemMaster() {
    this.clearCache(); // Reset cache khi bootstrap lại
    const imInfo = this.tableRepo.getDataByTableName("ITEM_MASTER");
    const imRows = imInfo ? imInfo.values : [];
    if (!imRows || imRows.length <= 1) return 0;

    const imHeaders = imRows[0];
    const idxItemCode = this._getColIdx(imHeaders, "item_code");
    const idxInvSku  = this._getColIdx(imHeaders, "inventory_sku") !== -1 
                        ? this._getColIdx(imHeaders, "inventory_sku") 
                        : this._getColIdx(imHeaders, "inventory_code");
    const idxUnit    = this._getColIdx(imHeaders, "base_unit");

    const bomInfo = this.tableRepo.getDataByTableName("BOM_RECIPE");
    const bomRows = bomInfo ? bomInfo.values : [];
    const existingPairs = new Set();

    if (bomRows && bomRows.length > 1) {
      const bomHeaders = bomRows[0];
      const idxParent  = this._getColIdx(bomHeaders, "parent_item_code");
      const idxChild   = this._getColIdx(bomHeaders, "child_item_code");

      for (let r = 1; r < bomRows.length; r++) {
        const p = String(bomRows[r][idxParent] || "").trim();
        const c = String(bomRows[r][idxChild] || "").trim();
        if (p && c) {
          existingPairs.add(`${p}${this.KEY_DELIMITER}${c}`);
        }
      }
    }

    const newBomRows = [];
    const primaryKeys = ["parent_item_code", "child_item_code"];

    for (let r = 1; r < imRows.length; r++) {
      const parentCode = String(imRows[r][idxItemCode] || "").trim();
      let childCode    = idxInvSku !== -1 ? String(imRows[r][idxInvSku] || "").trim() : "";
      
      if (!childCode) childCode = parentCode;
      if (!parentCode || !childCode) continue;

      const pairKey = `${parentCode}${this.KEY_DELIMITER}${childCode}`;
      if (!existingPairs.has(pairKey)) {
        const unit = idxUnit !== -1 ? String(imRows[r][idxUnit] || "").trim().toLowerCase() : "";
        
        newBomRows.push([
          parentCode, childCode, 1, unit, 1, true, "2026-01-01", "2099-12-31", true
        ]);
        existingPairs.add(pairKey);
      }
    }

    if (newBomRows.length > 0) {
      this.tableRepo.upsertRowsByTableName("BOM_RECIPE", newBomRows, primaryKeys);
      Logger.log(`[BOM SERVICE] Đã khởi tạo mới ${newBomRows.length} bản ghi BOM vào BOM_RECIPE.`);
    }

    return newBomRows.length;
  }

  clearCache() {
    this._cachedBomMap = null;
  }

  /**
   * Tải Map danh sách BOM hợp lệ - Có Cache In-Memory
   */
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

    const headers   = bomRows[0];
    const idxParent = this._getColIdx(headers, "parent_item_code");
    const idxChild  = this._getColIdx(headers, "child_item_code");
    const idxQty    = this._getColIdx(headers, "std_qty");
    const idxUnit   = this._getColIdx(headers, "unit");
    const idxLevel  = this._getColIdx(headers, "bom_level");
    const idxLeaf   = this._getColIdx(headers, "is_leaf");
    const idxFrom   = this._getColIdx(headers, "effective_from");
    const idxTo     = this._getColIdx(headers, "effective_to");
    const idxActive = this._getColIdx(headers, "is_active");

    for (let r = 1; r < bomRows.length; r++) {
      const row = bomRows[r];
      const parent = String(row[idxParent] || "").trim();
      const child  = String(row[idxChild] || "").trim();
      const qty    = Number(row[idxQty]) || 0;
      const unit   = String(row[idxUnit] || "").trim();
      const level  = idxLevel !== -1 ? (Number(row[idxLevel]) || 1) : 1;
      
      const strLeaf   = String(row[idxLeaf] || "").trim().toUpperCase();
      const isLeaf    = strLeaf === "TRUE" || strLeaf === "1" || row[idxLeaf] === true;
      
      const strActive = idxActive !== -1 ? String(row[idxActive] || "").trim().toUpperCase() : "TRUE";
      const isActive  = strActive === "TRUE" || strActive === "1" || row[idxActive] === true;

      if (!parent || !child || !isActive) continue;

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

  explodeBom(parentCode, parentQty = 1, targetTime = new Date()) {
    const targetDate = this._resolveTargetDate(targetTime);
    const bomMap = this._loadEffectiveBomMap(targetDate);
    const explodedResults = [];

    const recurse = (currentParent, currentQty, depth = 1) => {
      const children = bomMap.get(currentParent) || [];

      if (children.length === 0) return;

      for (const child of children) {
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

    return children.map(c => ({
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
