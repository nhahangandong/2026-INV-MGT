/**
 * [SERVICE] FactProcessingService.js
 * Xử lý tính toán và đổ dữ liệu từ STG sang FACT.
 * - Sửa lỗi map cột inventory_sku vào FACT_INBOUND & FACT_OUTBOUND
 * - Tra cứu giá vốn 4 cấp (Kỳ N -> Kỳ N-x -> STG_INVENTORY_OPENING -> ITEM_MASTER.base_cost)
 * - Tích hợp tra cứu tỷ lệ phân bổ Overhead theo Ma trận Danh mục & Thời gian (Time-versioning)
 */
class FactProcessingService {
  constructor(tableRepo, schemaService, sysConfigService = null, bomService = null) {
    if (!tableRepo || !schemaService) {
      throw new Error("[FactProcessingService] Thieu Dependency bat buộc (tableRepo, schemaService).");
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
      Logger.log(`[WARN] Loi parse JSON cho configKey '${configKey}': ${e.message}`);
      return fallbackValue;
    }
  }

  /**
   * Doc danh sach ALLOCATION_RULE theo luoc do moi
   */
  _buildAllocationRulesList() {
    const allocInfo = this.tableRepo.getDataByTableName("ALLOCATION_RULE");
    const allocRows = allocInfo ? allocInfo.values : [];
    const rulesList = [];

    if (allocRows && allocRows.length > 1) {
      const pCatIdx    = this._getColIndex("ALLOCATION_RULE", "parent_category");
      const targetIdx  = this._getColIndex("ALLOCATION_RULE", "target_type");
      const rateIdx    = this._getColIndex("ALLOCATION_RULE", "allocation_rate");
      const effFromIdx = this._getColIndex("ALLOCATION_RULE", "effective_from");
      const effToIdx   = this._getColIndex("ALLOCATION_RULE", "effective_to");
      const activeIdx  = this._getColIndex("ALLOCATION_RULE", "is_active");
      const prioIdx    = this._getColIndex("ALLOCATION_RULE", "priority");

      for (let i = 1; i < allocRows.length; i++) {
        const rawActive = String(allocRows[i][activeIdx] || "").trim().toUpperCase();
        const isActive  = rawActive === "TRUE" || rawActive === "1" || allocRows[i][activeIdx] === true;
        if (!isActive) continue;

        rulesList.push({
          parentCategory: pCatIdx !== -1 ? String(allocRows[i][pCatIdx] || "").trim() : "ALL",
          targetType:     targetIdx !== -1 ? String(allocRows[i][targetIdx] || "").trim() : "RAW_MATERIAL",
          allocationRate: rateIdx !== -1 ? (Number(allocRows[i][rateIdx]) || 0) : 0,
          effectiveFrom:  effFromIdx !== -1 ? allocRows[i][effFromIdx] : "1970-01-01",
          effectiveTo:    effToIdx !== -1 ? allocRows[i][effToIdx] : "2099-12-31",
          priority:       prioIdx !== -1 ? (Number(allocRows[i][prioIdx]) || 99) : 99,
          isActive:       true
        });
      }
    }
    return rulesList;
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
        
        if ((grp === sourceGroup || grp === "SO" || grp === "PO" || grp === "INT" || grp === "ALL") && code && altUnit) {
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
   * Doc ITEM_MASTER voi day du category va item_type
   */
  _buildItemMasterDictionary() {
    const imInfo = this.tableRepo.getDataByTableName("ITEM_MASTER");
    const imRows = imInfo ? imInfo.values : [];
    const dict = {
      byItemCode: {},
      byInventorySku: {}
    };

    if (imRows && imRows.length > 1) {
      const codeIdx     = this._getColIndex("ITEM_MASTER", "item_code");
      const baseIdx     = this._getColIndex("ITEM_MASTER", "base_unit");
      const invSkuIdx   = this._getColIndex("ITEM_MASTER", "inventory_sku") !== -1 
                           ? this._getColIndex("ITEM_MASTER", "inventory_sku") 
                           : this._getColIndex("ITEM_MASTER", "inventory_code");
      const factorIdx   = this._getColIndex("ITEM_MASTER", "stg_factor_to_base");
      const baseCostIdx = this._getColIndex("ITEM_MASTER", "base_cost");
      const catIdx      = this._getColIndex("ITEM_MASTER", "category");
      const typeIdx     = this._getColIndex("ITEM_MASTER", "item_type");

      for (let i = 1; i < imRows.length; i++) {
        const itemCode = String(imRows[i][codeIdx] || "").trim();
        const invSku   = invSkuIdx !== -1 ? String(imRows[i][invSkuIdx] || "").trim() : "";
        const baseUnit = String(imRows[i][baseIdx] || "").trim().toLowerCase();
        const factor   = factorIdx !== -1 ? (Number(imRows[i][factorIdx]) || 1) : 1;
        const baseCost = baseCostIdx !== -1 ? (Number(imRows[i][baseCostIdx]) || 0) : 0;
        const category = catIdx !== -1 ? String(imRows[i][catIdx] || "").trim() : "";
        const itemType = typeIdx !== -1 ? String(imRows[i][typeIdx] || "").trim() : "";

        const info = {
          itemCode,
          inventorySku: invSku || itemCode,
          baseUnit,
          stgFactor: factor,
          baseCost,
          category,
          itemType
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

  _resolveEstUnitCost(period, childItemCode, inboundPriceDict, openingPriceDict, imDict) {
    if (!childItemCode) return 0;

    const currentPeriodNum = Number(period);

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

    if (openingPriceDict.hasOwnProperty(childItemCode) && openingPriceDict[childItemCode] > 0) {
      return openingPriceDict[childItemCode];
    }

    const imInfo = imDict.byInventorySku[childItemCode] || imDict.byItemCode[childItemCode] || {};
    return imInfo.baseCost || 0;
  }

  getOverheadRate(parentItemCode, childItemCode, transDate, imDict, allocRules) {
    if (!childItemCode) return 0;

    const parentInfo = imDict.byItemCode[parentItemCode] || {};
    const childInfo  = imDict.byInventorySku[childItemCode] || imDict.byItemCode[childItemCode] || {};

    const parentCategory = (parentInfo.category || 'ALL').trim().toUpperCase();
    const childItemType  = (childInfo.itemType || '').trim().toUpperCase();

    if (childItemType !== 'RAW_MATERIAL') {
      return 0;
    }

    const validRules = allocRules.filter(rule => {
      if (!rule.isActive) return false;
    
      const effFrom = new Date(rule.effectiveFrom);
      const effTo   = new Date(rule.effectiveTo);
      const tDate   = new Date(transDate);
    
      if (tDate < effFrom || tDate > effTo) return false;
      if (rule.targetType && rule.targetType.toUpperCase() !== 'RAW_MATERIAL') return false;

      const ruleCategory = (rule.parentCategory || 'ALL').toUpperCase();
      return ruleCategory === parentCategory || ruleCategory === 'ALL';
    });

    if (validRules.length === 0) {
      return 0;
    }

    validRules.sort((a, b) => {
      if (a.priority === b.priority) {
        if (a.parentCategory !== 'ALL' && b.parentCategory === 'ALL') return -1;
        if (a.parentCategory === 'ALL' && b.parentCategory !== 'ALL') return 1;
      }
      return a.priority - b.priority;
    });

    return validRules[0].allocationRate;
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
      Logger.log(`[FACT INBOUND] Da xu ly & ghi thanh cong ${factRows.length} dong vao FACT_INBOUND.`);
    }

    return factRows.length;
  }

  /**
   * Tinh toan Fact Outbound tu STG_SO_INVOICE + BOM_RECIPE
   * Map chinh xac theo Schema FACT_OUTBOUND
   */
  processFactOutbound(periodFilter = null) {
    const stgSchemaKey = "STG_SO_INVOICE";
    const factSchemaKey = "FACT_OUTBOUND";

    const primaryKeys = this._getSysConfigJson("FACT_OUTBOUND_PRIMARY_KEYS", ["doc_code", "line_no", "child_item_code"]);

    const stgInfo = this.tableRepo.getDataByTableName(stgSchemaKey);
    const stgRows = stgInfo ? stgInfo.values : [];
    if (!stgRows || stgRows.length <= 1) return 0;

    if (!this.bomService) {
      throw new Error("[FactProcessingService] Thieu bomService khi xu ly processFactOutbound.");
    }

    const ucDict = this._buildUnitConversionDictionary("SO");
    const imDict = this._buildItemMasterDictionary();
    const allocRulesList = this._buildAllocationRulesList();
    const inboundPriceDict = this._buildInboundAvgPriceDict();
    const openingPriceDict = this._buildOpeningInventoryPriceDict(imDict);

    const idxSTG = {
      period:   this._getColIndex(stgSchemaKey, "period"),
      transDate:this._getColIndex(stgSchemaKey, "invoice_date") !== -1 ? this._getColIndex(stgSchemaKey, "invoice_date") : this._getColIndex(stgSchemaKey, "trans_date"),
      docCode:  this._getColIndex(stgSchemaKey, "invoice_code") !== -1 ? this._getColIndex(stgSchemaKey, "invoice_code") : this._getColIndex(stgSchemaKey, "doc_code"),
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

      const docCode = idxSTG.docCode !== -1 ? toCleanString(r[idxSTG.docCode]) : "";
      if (!docCode) continue;

      const lineNo    = idxSTG.lineNo !== -1 ? toCleanString(r[idxSTG.lineNo]) : "";
      const transDate = idxSTG.transDate !== -1 ? r[idxSTG.transDate] : "";
      const parentCode= idxSTG.itemCode !== -1 ? toCleanString(r[idxSTG.itemCode]) : "";
      const stgUnit   = idxSTG.unit !== -1 ? toCleanString(r[idxSTG.unit]) : "";
      const soldQty   = parseNum(idxSTG.qty !== -1 ? r[idxSTG.qty] : 0);

      if (!parentCode) continue;

      // 1. Lay danh sach thanh phan BOM tu BomService
      const rawBomComponents = this.bomService.getBomComponents(parentCode, transDate) || [];

      // 2. LOC CHI LAY CAC DONG BOM CO IS_ACTIVE = TRUE VA CHILD_ITEM_CODE VALID (!= NULL/RONG)
      const validBomComponents = rawBomComponents.filter(comp => {
        // Kiem tra is_active
        const isActiveVal = comp.is_active !== undefined ? comp.is_active : comp.isActive;
        let isActive = true;
        if (isActiveVal !== undefined && isActiveVal !== null) {
          if (typeof isActiveVal === 'boolean') isActive = isActiveVal;
          else if (typeof isActiveVal === 'string') isActive = isActiveVal.trim().toLowerCase() === 'true' || isActiveVal.trim() === '1';
          else if (typeof isActiveVal === 'number') isActive = isActiveVal === 1;
          else isActive = Boolean(isActiveVal);
        }
        if (!isActive) return false;

        // Kiem tra child_item_code phai ton tai
        const rawChildCode = comp.child_item_code || comp.childItemCode;
        const childCode = rawChildCode ? String(rawChildCode).trim() : "";
        return childCode !== "" && childCode.toLowerCase() !== "null";
      });

      // KHONG GHI NHAN OUTBOUND NEU KHONG CO DONG CHILD_ITEM HOP LE
      if (validBomComponents.length === 0) {
        continue;
      }

      // 3. CHI THEM VAO FACT_OUTBOUND KHI CO DINH LUONG BUNG BOM CHUAN
      validBomComponents.forEach(comp => {
        const rawChildCode = comp.child_item_code || comp.childItemCode;
        const childCode = String(rawChildCode).trim();

        const bomNormQty = Number(comp.std_qty || comp.stdQty) || 0;
        const bomDepth   = Number(comp.bom_level || comp.bomLevel) || 1;

        const childInfo = imDict.byItemCode[childCode] || imDict.byInventorySku[childCode] || {};
        const childSku  = childInfo.inventorySku || childCode;
        const baseUnit  = comp.unit || childInfo.baseUnit || stgUnit;

        // Tinh toan consumed_qty, chi phi
        const consumedQty = soldQty * bomNormQty;
        const estUnitCost = this._resolveEstUnitCost(period, childSku, inboundPriceDict, openingPriceDict, imDict);
        const rawFoodCost = consumedQty * estUnitCost;

        // Tra cuu Overhead Rate
        const overheadRate = this.getOverheadRate(parentCode, childSku, transDate, imDict, allocRulesList);
        const overheadCost = rawFoodCost * overheadRate;
        const totalFoodCost = rawFoodCost + overheadCost;

        const computedFactObj = {
          "period":           period,
          "trans_date":       transDate,
          "doc_code":         docCode,
          "line_no":          lineNo,
          "parent_item_code": parentCode,
          "child_item_code":  childSku,
          "bom_depth":        bomDepth,
          "sold_qty":         soldQty,
          "bom_norm_qty":     bomNormQty,
          "base_unit":        baseUnit,
          "consumed_qty":     consumedQty,
          "est_unit_cost":    estUnitCost,
          "raw_food_cost":    rawFoodCost,
          "overhead_rate":    overheadRate,
          "overhead_cost":    overheadCost,
          "total_food_cost":  totalFoodCost
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

    if (factRows.length > 0) {
      this.tableRepo.upsertRowsByTableName(factSchemaKey, factRows, primaryKeys);
      Logger.log(`[FACT OUTBOUND] Da xu ly & ghi thanh cong ${factRows.length} dong vao FACT_OUTBOUND.`);
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
