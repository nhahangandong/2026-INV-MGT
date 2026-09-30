/**
 * [SERVICE] FactProcessingService.js
 * Xử lý tính toán và đổ dữ liệu từ STG sang FACT.
 * - Sửa lỗi map cột inventory_sku vào FACT_INBOUND
 * - Chuẩn hóa tra cứu giá vốn 4 cấp (Kỳ N -> Kỳ N-x -> STG_INVENTORY_OPENING -> ITEM_MASTER.base_cost)
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

  _getColIndex(schemaName, colKey) {
    const schemaMap = (typeof this.schemaService.getSchemaMap === 'function') 
      ? this.schemaService.getSchemaMap() 
      : null;
    const col1Based = this.schemaService.getColIndex(schemaMap, schemaName, colKey);
    return col1Based > 0 ? col1Based - 1 : -1;
  }

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

  _buildAllocationRuleDictionary() {
    const allocInfo = this.tableRepo.getDataByTableName("ALLOCATION_RULE");
    const allocRows = allocInfo ? allocInfo.values : [];
    
    const result = {
      itemOverheadMap: {},
      defaultRate: 0
    };

    if (allocRows && allocRows.length > 1) {
      const codeIdx   = this._getColIndex("ALLOCATION_RULE", "item_code");
      const rateIdx   = this._getColIndex("ALLOCATION_RULE", "allocation_rate");
      const activeIdx = this._getColIndex("ALLOCATION_RULE", "is_active");

      for (let i = 1; i < allocRows.length; i++) {
        const rawActive = String(allocRows[i][activeIdx] || "").trim().toUpperCase();
        const isActive  = rawActive === "TRUE" || rawActive === "1" || allocRows[i][activeIdx] === true;
        if (!isActive) continue;

        const itemCode = codeIdx !== -1 ? String(allocRows[i][codeIdx] || "").trim() : "";
        const rate     = rateIdx !== -1 ? (Number(allocRows[i][rateIdx]) || 0) : 0;

        if (itemCode && itemCode.toUpperCase() !== "ALL" && itemCode !== "*") {
          result.itemOverheadMap[itemCode] = rate;
        } else {
          result.defaultRate = rate;
        }
      }
    }
    return result;
  }

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

  _buildItemMasterDictionary() {
    const imInfo = this.tableRepo.getDataByTableName("ITEM_MASTER");
    const imRows = imInfo ? imInfo.values : [];
    const dict = {
      byItemCode: {},
      byInventorySku: {}
    };

    if (imRows && imRows.length > 1) {
      const codeIdx   = this._getColIndex("ITEM_MASTER", "item_code");
      const baseIdx   = this._getColIndex("ITEM_MASTER", "base_unit");
      const invSkuIdx = this._getColIndex("ITEM_MASTER", "inventory_sku") !== -1 
                         ? this._getColIndex("ITEM_MASTER", "inventory_sku") 
                         : this._getColIndex("ITEM_MASTER", "inventory_code");
      const factorIdx   = this._getColIndex("ITEM_MASTER", "stg_factor_to_base");
      const baseCostIdx = this._getColIndex("ITEM_MASTER", "base_cost");

      for (let i = 1; i < imRows.length; i++) {
        const itemCode = String(imRows[i][codeIdx] || "").trim();
        const invSku   = invSkuIdx !== -1 ? String(imRows[i][invSkuIdx] || "").trim() : "";
        const baseUnit = String(imRows[i][baseIdx] || "").trim().toLowerCase();
        const factor   = factorIdx !== -1 ? (Number(imRows[i][factorIdx]) || 1) : 1;
        const baseCost = baseCostIdx !== -1 ? (Number(imRows[i][baseCostIdx]) || 0) : 0;

        const info = {
          itemCode,
          inventorySku: invSku || itemCode,
          baseUnit,
          stgFactor: factor,
          baseCost
        };

        if (itemCode) dict.byItemCode[itemCode] = info;
        if (invSku) dict.byInventorySku[invSku] = info;
      }
    }
    return dict;
  }

  _resolveConversionFactorAndBaseUnit(sourceGrp, itemCode, stgUnit, ucDict, imDict) {
    const cleanGrp  = String(sourceGrp || "INT").trim().toUpperCase();
    const cleanCode = String(itemCode || "").trim();
    const cleanUnit = String(stgUnit || "").trim().toLowerCase();

    const imInfo = imDict.byItemCode[cleanCode] || {};
    let baseUnit = imInfo.baseUnit || cleanUnit;
    let factor = 1;

    const ucKey = [cleanGrp, cleanCode, cleanUnit].join(this.KEY_DELIMITER);
    const ucInfo = ucDict[ucKey];

    if (ucInfo && Number(ucInfo.factor) > 0) {
      factor = Number(ucInfo.factor);
      if (ucInfo.baseUnit) baseUnit = ucInfo.baseUnit;
    } else if (imInfo.stgFactor && Number(imInfo.stgFactor) > 0) {
      factor = Number(imInfo.stgFactor);
    }

    return { factor, baseUnit };
  }

  /**
   * Tổng hợp đơn giá bình quân nhập kho theo [period, inventory_sku]
   */
  _buildInboundAvgPriceDict() {
    const factInfo = this.tableRepo.getDataByTableName("FACT_INBOUND");
    const factRows = factInfo ? factInfo.values : [];
    const summary = {};

    if (factRows && factRows.length > 1) {
      const periodIdx = this._getColIndex("FACT_INBOUND", "period");
      const skuIdx    = this._getColIndex("FACT_INBOUND", "inventory_sku") !== -1
                        ? this._getColIndex("FACT_INBOUND", "inventory_sku")
                        : this._getColIndex("FACT_INBOUND", "child_item_code");
      const qtyIdx    = this._getColIndex("FACT_INBOUND", "base_qty");
      const amtIdx    = this._getColIndex("FACT_INBOUND", "amount");

      for (let i = 1; i < factRows.length; i++) {
        const row = factRows[i];
        const period = String(row[periodIdx] || "").trim();
        const sku    = String(row[skuIdx] || "").trim();
        const qty    = Number(row[qtyIdx]) || 0;
        const amt    = Number(row[amtIdx]) || 0;

        if (period && sku && qty > 0) {
          const key = [period, sku].join(this.KEY_DELIMITER);
          if (!summary[key]) {
            summary[key] = { totalQty: 0, totalAmt: 0 };
          }
          summary[key].totalQty += qty;
          summary[key].totalAmt += amt;
        }
      }
    }

    const priceDict = {};
    Object.keys(summary).forEach(key => {
      const item = summary[key];
      priceDict[key] = item.totalQty > 0 ? (item.totalAmt / item.totalQty) : 0;
    });

    return priceDict;
  }

  /**
   * Đọc bảng tồn kho đầu kỳ STG_INVENTORY_OPENING
   * Ánh xạ item_code -> inventory_sku thông qua ITEM_MASTER để lưu theo inventory_sku
   */
  _buildOpeningInventoryPriceDict(imDict) {
    const opInfo = this.tableRepo.getDataByTableName("STG_INVENTORY_OPENING");
    const opRows = opInfo ? opInfo.values : [];
    const dict = {};

    if (opRows && opRows.length > 1) {
      const codeIdx = this._getColIndex("STG_INVENTORY_OPENING", "item_code");
      const qtyIdx  = this._getColIndex("STG_INVENTORY_OPENING", "quantity") !== -1
                      ? this._getColIndex("STG_INVENTORY_OPENING", "quantity")
                      : this._getColIndex("STG_INVENTORY_OPENING", "opening_qty");
      const amtIdx  = this._getColIndex("STG_INVENTORY_OPENING", "amount") !== -1
                      ? this._getColIndex("STG_INVENTORY_OPENING", "amount")
                      : this._getColIndex("STG_INVENTORY_OPENING", "opening_amount");
      const priceIdx = this._getColIndex("STG_INVENTORY_OPENING", "price") !== -1
                      ? this._getColIndex("STG_INVENTORY_OPENING", "price")
                      : this._getColIndex("STG_INVENTORY_OPENING", "unit_cost");

      for (let i = 1; i < opRows.length; i++) {
        const itemCode = String(opRows[i][codeIdx] || "").trim();
        if (!itemCode) continue;

        // Tra cứu SKU từ ITEM_MASTER
        const imInfo = imDict.byItemCode[itemCode] || {};
        const sku = imInfo.inventorySku || itemCode;

        const qty   = qtyIdx !== -1 ? (Number(opRows[i][qtyIdx]) || 0) : 0;
        const amt   = amtIdx !== -1 ? (Number(opRows[i][amtIdx]) || 0) : 0;
        const price = priceIdx !== -1 ? (Number(opRows[i][priceIdx]) || 0) : 0;

        let unitCost = 0;
        if (qty > 0 && amt > 0) {
          unitCost = amt / qty;
        } else if (price > 0) {
          unitCost = price;
        }

        if (sku && unitCost > 0) {
          dict[sku] = unitCost;
        }
      }
    }
    return dict;
  }

  /**
   * Tra cứu Đơn giá vốn (est_unit_cost) theo đúng quy ước 4 cấp:
   * 1. Kỳ hiện tại N trong FACT_INBOUND
   * 2. Các kỳ lùi dần (N-1, N-2...) trong FACT_INBOUND
   * 3. Bảng tồn kho đầu kỳ STG_INVENTORY_OPENING (tra cứu qua ITEM_MASTER)
   * 4. Trường base_cost trong ITEM_MASTER
   */
  _resolveEstUnitCost(period, childItemCode, inboundPriceDict, openingPriceDict, imDict) {
    if (!childItemCode) return 0;

    const currentPeriodNum = Number(period);

    // BƯỚC 1 & 2: Tra cứu trong FACT_INBOUND (Kỳ N -> Kỳ N-1 -> N-2...)
    const availablePeriods = Object.keys(inboundPriceDict)
      .map(k => k.split(this.KEY_DELIMITER)[0])
      .filter((v, idx, arr) => arr.indexOf(v) === idx)
      .map(Number)
      .sort((a, b) => b - a);

    for (const p of availablePeriods) {
      if (p <= currentPeriodNum) {
        const key = [String(p), childItemCode].join(this.KEY_DELIMITER);
        if (inboundPriceDict[key] && inboundPriceDict[key] > 0) {
          return inboundPriceDict[key];
        }
      }
    }

    // BƯỚC 3: Tra cứu trong STG_INVENTORY_OPENING (đã được map theo inventory_sku)
    if (openingPriceDict.hasOwnProperty(childItemCode) && openingPriceDict[childItemCode] > 0) {
      return openingPriceDict[childItemCode];
    }

    // BƯỚC 4: Fallback về base_cost trong ITEM_MASTER
    const imInfo = imDict.byInventorySku[childItemCode] || imDict.byItemCode[childItemCode] || {};
    return imInfo.baseCost || 0;
  }

  processFactInbound(periodFilter = null) {
    const stgSchemaKey = "STG_PO_INVOICE";
    const factSchemaKey = "FACT_INBOUND";

    const primaryKeys = this._getSysConfigJson("FACT_INBOUND_PRIMARY_KEYS", ["doc_code", "line_no"]);

    const stgInfo = this.tableRepo.getDataByTableName(stgSchemaKey);
    const stgRows = stgInfo ? stgInfo.values : [];
    if (!stgRows || stgRows.length <= 1) return 0;

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
      if (val === null || val === undefined) return 0;
      const num = Number(String(val).replace(/,/g, '').trim());
      return isNaN(num) ? 0 : num;
    };

    const toCleanString = (val) => {
      if (val === null || val === undefined) return "";
      return String(val).trim();
    };

    const schemaMap = this.schemaService.getSchemaMap();
    const factSchema = schemaMap[factSchemaKey] || schemaMap[factSchemaKey.toLowerCase()];
    const colDefs = factSchema ? (factSchema.columns || factSchema) : {};

    const factRows = [];
    const cleanPeriodFilter = periodFilter !== null && periodFilter !== undefined ? toCleanString(periodFilter) : "";

    for (let i = 1; i < stgRows.length; i++) {
      const r = stgRows[i];

      const period = idxSTG.period !== -1 ? toCleanString(r[idxSTG.period]) : "";
      if (cleanPeriodFilter !== "" && period !== cleanPeriodFilter) continue;

      const invCode = idxSTG.invCode !== -1 ? toCleanString(r[idxSTG.invCode]) : "";
      if (!invCode) continue;

      const lineNo   = idxSTG.lineNo !== -1 ? toCleanString(r[idxSTG.lineNo]) : "";
      const invDate  = idxSTG.invDate !== -1 ? r[idxSTG.invDate] : "";
      const itemCode = idxSTG.itemCode !== -1 ? toCleanString(r[idxSTG.itemCode]) : "";
      const stgUnit  = idxSTG.unit !== -1 ? toCleanString(r[idxSTG.unit]) : "";
      
      const qty    = parseNum(idxSTG.qty !== -1 ? r[idxSTG.qty] : 0);
      const price  = parseNum(idxSTG.price !== -1 ? r[idxSTG.price] : 0);
      const amount = parseNum(idxSTG.amount !== -1 ? r[idxSTG.amount] : 0);
      const taxAmt = parseNum(idxSTG.taxAmt !== -1 ? r[idxSTG.taxAmt] : 0);

      const imInfo = imDict.byItemCode[itemCode] || {};
      const inventorySku = imInfo.inventorySku || itemCode;

      const { factor, baseUnit } = this._resolveConversionFactorAndBaseUnit("INT", itemCode, stgUnit, ucDict, imDict);

      const baseQty     = qty * factor;
      const basePrice   = factor !== 0 ? price / factor : price;
      const totalAmount = amount + taxAmt;

      // Object cấu trúc chuẩn với cả 'inventory_sku' lẫn 'child_item_code'
      const computedFactObj = {
        "period":          period,
        "trans_date":      invDate,
        "doc_code":        invCode,
        "line_no":         lineNo,
        "item_code":       itemCode,
        "inventory_sku":   inventorySku,
        "child_item_code": inventorySku,
        "base_unit":       baseUnit,
        "base_qty":        baseQty,
        "base_price":      basePrice,
        "amount":          amount,
        "tax_amount":      taxAmt,
        "total_amount":    totalAmount
      };

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

    if (factRows.length > 0) {
      this.tableRepo.upsertRowsByTableName(factSchemaKey, factRows, primaryKeys);
      Logger.log(`[FACT INBOUND] Đã xử lý & ghi thành công ${factRows.length} dòng vào FACT_INBOUND.`);
    }

    return factRows.length;
  }

  processFactOutbound(periodFilter = null) {
    const stgSchemaKey = "STG_SO_INVOICE";
    const factSchemaKey = "FACT_OUTBOUND";

    const primaryKeys = this._getSysConfigJson(
      "FACT_OUTBOUND_PRIMARY_KEYS", 
      ["doc_code", "line_no", "child_item_code"]
    );

    const stgInfo = this.tableRepo.getDataByTableName(stgSchemaKey);
    const stgRows = stgInfo ? stgInfo.values : [];
    if (!stgRows || stgRows.length <= 1) {
      Logger.log("[FACT OUTBOUND] Bảng STG_SO_INVOICE không có dữ liệu!");
      return 0;
    }

    const allocDict        = this._buildAllocationRuleDictionary();
    const ucDict           = this._buildUnitConversionDictionary("SO");
    const imDict           = this._buildItemMasterDictionary();
    const inboundPriceDict = this._buildInboundAvgPriceDict();
    const openingPriceDict = this._buildOpeningInventoryPriceDict(imDict);

    const idxSTG = {
      period:   this._getColIndex(stgSchemaKey, "period"),
      invDate:  this._getColIndex(stgSchemaKey, "invoice_date"),
      invCode:  this._getColIndex(stgSchemaKey, "invoice_code"),
      lineNo:   this._getColIndex(stgSchemaKey, "line_no"),
      itemCode: this._getColIndex(stgSchemaKey, "item_code"),
      unit:     this._getColIndex(stgSchemaKey, "unit"),
      qty:      this._getColIndex(stgSchemaKey, "quantity"),
      price:    this._getColIndex(stgSchemaKey, "price"),
      amount:   this._getColIndex(stgSchemaKey, "amount")
    };

    const parseNum = (val) => {
      if (typeof val === 'number') return isNaN(val) ? 0 : val;
      if (val === null || val === undefined) return 0;
      const cleanStr = String(val).replace(/,/g, '').trim();
      const num = Number(cleanStr);
      return isNaN(num) ? 0 : num;
    };

    const toCleanString = (val) => {
      if (val === null || val === undefined) return "";
      return String(val).trim();
    };

    const schemaMap = this.schemaService.getSchemaMap();
    const factSchema = schemaMap[factSchemaKey] || schemaMap[factSchemaKey.toLowerCase()];
    const colDefs = factSchema ? (factSchema.columns || factSchema) : {};

    const factRows = [];
    const cleanPeriodFilter = periodFilter !== null && periodFilter !== undefined ? toCleanString(periodFilter) : "";
    const missingBomSet = new Set();

    for (let i = 1; i < stgRows.length; i++) {
      const r = stgRows[i];

      const period = idxSTG.period !== -1 ? toCleanString(r[idxSTG.period]) : "";
      if (cleanPeriodFilter !== "" && period !== cleanPeriodFilter) {
        continue;
      }

      const invCode = idxSTG.invCode !== -1 ? toCleanString(r[idxSTG.invCode]) : "";
      if (!invCode) continue;

      const lineNo   = idxSTG.lineNo !== -1 ? toCleanString(r[idxSTG.lineNo]) : "";
      const invDate  = idxSTG.invDate !== -1 ? r[idxSTG.invDate] : "";
      const parentItemCode = idxSTG.itemCode !== -1 ? toCleanString(r[idxSTG.itemCode]) : "";
      const soldQty  = parseNum(idxSTG.qty !== -1 ? r[idxSTG.qty] : 0);

      if (!parentItemCode || soldQty === 0) continue;

      let bomComponents = [];
      if (this.bomService && typeof this.bomService.explodeBom === 'function') {
        bomComponents = this.bomService.explodeBom(parentItemCode, 1, period);
      }

      if (!bomComponents || bomComponents.length === 0) {
        if (this.bomService && typeof this.bomService.getDirectRecipe === 'function') {
          bomComponents = this.bomService.getDirectRecipe(parentItemCode, period);
        }
      }

      if (!bomComponents || bomComponents.length === 0) {
        missingBomSet.add(parentItemCode);
        continue;
      }

      bomComponents.forEach(comp => {
        const childItemCode = toCleanString(
          comp.child_item_code || 
          comp.childItemCode || 
          comp.inventory_sku || 
          ""
        );

        if (!childItemCode) return;

        const bomDepth = parseNum(comp.bom_level || comp.bomDepth) || 1;
        const normQty  = parseNum(comp.std_qty || comp.normQty) || 1;
        
        const compImInfo = imDict.byInventorySku[childItemCode] || imDict.byItemCode[childItemCode] || {};
        const baseUnit   = toCleanString(comp.unit || comp.baseUnit || compImInfo.baseUnit || "").toLowerCase();

        const consumedQty = soldQty * normQty;
        
        // Tính giá vốn theo quy ước 4 cấp
        const estUnitCost = comp.unitCost || this._resolveEstUnitCost(period, childItemCode, inboundPriceDict, openingPriceDict, imDict);
        const rawFoodCost = consumedQty * estUnitCost;

        let overheadRate = 0;
        if (allocDict.itemOverheadMap.hasOwnProperty(parentItemCode)) {
          overheadRate = allocDict.itemOverheadMap[parentItemCode];
        } else if (allocDict.itemOverheadMap.hasOwnProperty(childItemCode)) {
          overheadRate = allocDict.itemOverheadMap[childItemCode];
        } else {
          overheadRate = allocDict.defaultRate;
        }

        const overheadAmt = rawFoodCost * overheadRate;

        const computedFactObj = {
          "period":           period,
          "trans_date":       invDate,
          "doc_code":         invCode,
          "line_no":          lineNo,
          "parent_item_code": parentItemCode,
          "child_item_code":  childItemCode,
          "bom_depth":        bomDepth,
          "sold_qty":         soldQty,
          "bom_norm_qty":     normQty,
          "base_unit":        baseUnit,
          "consumed_qty":     consumedQty,
          "est_unit_cost":    estUnitCost,
          "raw_food_cost":    rawFoodCost,
          "overhead_rate":    overheadRate,
          "overhead_amount":  overheadAmt,
          "total_cogs":       rawFoodCost + overheadAmt
        };

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
      });
    }

    if (missingBomSet.size > 0) {
      Logger.log(`[WARN] Có ${missingBomSet.size} mã trong STG chưa khai báo/chưa active BOM: ${Array.from(missingBomSet).join(", ")}`);
    }

    if (factRows.length > 0) {
      this.tableRepo.upsertRowsByTableName(factSchemaKey, factRows, primaryKeys);
      Logger.log(`[FACT OUTBOUND] Đã xử lý & ghi thành công ${factRows.length} dòng vào FACT_OUTBOUND.`);
    }

    return factRows.length;
  }

  recalculateFactOnUnitConversionChange(sourceGroup = "ALL") {
    const isAll = String(sourceGroup || "").trim().toUpperCase() === "ALL";
    let total = 0;

    if (isAll || sourceGroup === "PO" || sourceGroup === "INT") {
      total += this.processFactInbound();
    }
    if (isAll || sourceGroup === "SO") {
      total += this.processFactOutbound();
    }
    return total;
  }
}
