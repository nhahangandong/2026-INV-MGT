/**
 * [SERVICE] FactProcessingService.js
 * Xử lý bùng nổ BOM, ánh xạ món bán thành NVL và tổng hợp Fact Inbound / Outbound
 */
class FactProcessingService {
  constructor(tableRepo, schemaService, bomService = null) {
    this.tableRepo = tableRepo;
    this.schemaService = schemaService;
    this.bomService = bomService;
  }

  /**
   * Helper: Chuẩn hóa chuỗi period về dạng thuần số để so sánh chính xác (VD: "2026-09" -> "202609")
   */
  _normalizePeriod(p) {
    if (!p) return "";
    return String(p).replace(/[-_\s]/g, "").trim();
  }

  /**
   * Helper: Xóa sạch toàn bộ dữ liệu Fact thuộc các kỳ bị ảnh hưởng
   */
  _clearExistingFactDataByPeriods(tableName, affectedPeriods) {
    if (!affectedPeriods || affectedPeriods.size === 0) return;

    // Chuẩn hóa danh sách kỳ bị ảnh hưởng thành Set chuỗi số thuần
    const normalizedAffectedSet = new Set(
      Array.from(affectedPeriods).map(p => this._normalizePeriod(p))
    );

    const factInfo = this.tableRepo.getDataByTableName(tableName);
    const factRows = factInfo ? factInfo.values : [];
    if (!factRows || factRows.length <= 1) return;

    const periodIdx = this._getColIndex(tableName, "period");
    if (periodIdx === -1) return;

    const filteredRows = [factRows[0]]; // Giữ lại Header
    let removedCount = 0;

    for (let i = 1; i < factRows.length; i++) {
      const pRaw = factRows[i][periodIdx];
      const pNorm = this._normalizePeriod(pRaw);

      if (normalizedAffectedSet.has(pNorm)) {
        removedCount++;
      } else {
        filteredRows.push(factRows[i]);
      }
    }

    if (removedCount > 0) {
      this.tableRepo.updateTableData(tableName, filteredRows);
      Logger.log(`[FACT CLEANUP] Đã làm sạch ${removedCount} dòng cũ trên [${tableName}] thuộc các kỳ: ${Array.from(affectedPeriods).join(", ")}`);
    }
  }

  /**
   * 1. Tổng hợp FACT_INBOUND từ STG_PO_INVOICE
   * @param {string|null} targetPeriod - Kỳ cần lọc từ Controller
   */
  processFactInbound(targetPeriod = null) {
    const targetPeriodNorm = this._normalizePeriod(targetPeriod);
    Logger.log(`[FACT INBOUND] Bắt đầu tổng hợp Fact Inbound (Kỳ lọc: ${targetPeriodNorm || "ALL"})...`);

    const stgInfo = this.tableRepo.getDataByTableName("STG_PO_INVOICE");
    const stgRows = stgInfo ? stgInfo.values : [];
    if (!stgRows || stgRows.length <= 1) return 0;

    const stgPeriodIdx   = this._getColIndex("STG_PO_INVOICE", "period");
    const stgDateIdx     = this._getColIndex("STG_PO_INVOICE", "invoice_date");
    const stgCodeIdx     = this._getColIndex("STG_PO_INVOICE", "invoice_code");
    const stgLineIdx     = this._getColIndex("STG_PO_INVOICE", "line_no");
    const stgItemCodeIdx = this._getColIndex("STG_PO_INVOICE", "item_code");
    const stgBaseUnitIdx = this._getColIndex("STG_PO_INVOICE", "base_unit");
    const stgBaseQtyIdx  = this._getColIndex("STG_PO_INVOICE", "base_qty");
    const stgBasePrcIdx  = this._getColIndex("STG_PO_INVOICE", "base_price");
    const stgAmtIdx      = this._getColIndex("STG_PO_INVOICE", "amount");
    const stgTaxAmtIdx   = this._getColIndex("STG_PO_INVOICE", "tax_amount");

    // LỌC TẠI NGUỒN STAGING
    const validStgRows = [];
    for (let i = 1; i < stgRows.length; i++) {
      const r = stgRows[i];
      const rPeriodNorm = this._normalizePeriod(r[stgPeriodIdx]);

      if (targetPeriodNorm && rPeriodNorm !== targetPeriodNorm) continue;

      const itemCode = String(r[stgItemCodeIdx] || "").trim();
      if (!itemCode) continue;

      validStgRows.push(r);
    }

    if (validStgRows.length === 0) {
      Logger.log(`[FACT INBOUND] Không tìm thấy dữ liệu Staging thỏa mãn điều kiện kỳ [${targetPeriodNorm || "ALL"}].`);
      return 0;
    }

    // Load Mapping item_code -> ingredient_code từ ITEM_MASTER
    const imInfo = this.tableRepo.getDataByTableName("ITEM_MASTER");
    const imRows = imInfo ? imInfo.values : [];
    const itemIngrMap = {};

    if (imRows && imRows.length > 1) {
      const codeIdx = this._getColIndex("ITEM_MASTER", "item_code");
      const ingrIdx = this._getColIndex("ITEM_MASTER", "ingredient_code");
      for (let i = 1; i < imRows.length; i++) {
        const c = String(imRows[i][codeIdx] || "").trim();
        const ing = String(imRows[i][ingrIdx] || "").trim();
        if (c) itemIngrMap[c] = ing || c;
      }
    }

    const factInboundRows = [];
    const affectedPeriods = new Set();

    for (let i = 0; i < validStgRows.length; i++) {
      const r = validStgRows[i];
      const rPeriod   = String(r[stgPeriodIdx] || "").trim();
      const itemCode  = String(r[stgItemCodeIdx] || "").trim();
      const baseQty   = Number(r[stgBaseQtyIdx]) || 0;
      const basePrice = Number(r[stgBasePrcIdx]) || 0;
      const amount    = Number(r[stgAmtIdx]) || (baseQty * basePrice);
      const taxAmt    = Number(r[stgTaxAmtIdx]) || 0;

      const row = [
        rPeriod,
        r[stgDateIdx],
        r[stgCodeIdx],
        r[stgLineIdx],
        itemCode,
        itemIngrMap[itemCode] || itemCode,
        r[stgBaseUnitIdx],
        baseQty,
        basePrice,
        amount,
        taxAmt,
        amount + taxAmt
      ];

      factInboundRows.push(row);
      if (rPeriod) affectedPeriods.add(rPeriod);
    }

    if (factInboundRows.length > 0) {
      // 1. Tẩy sạch dữ liệu cũ thuộc các kỳ bị ảnh hưởng
      this._clearExistingFactDataByPeriods("FACT_INBOUND", affectedPeriods);

      // 2. Ghi mới dữ liệu dạng Append (Tránh lỗi trôi cột hoặc ghi đè sót cột từ Upsert)
      this.tableRepo.appendRowsByTableName("FACT_INBOUND", factInboundRows);
      Logger.log(`[FACT INBOUND] Đã ghi thành công ${factInboundRows.length} dòng dữ liệu mới cho các kỳ: ${Array.from(affectedPeriods).join(", ")}`);
    }

    return factInboundRows.length;
  }

  /**
   * 2. Tổng hợp FACT_OUTBOUND từ STG_SO_INVOICE
   * @param {string|null} targetPeriod - Kỳ cần lọc từ Controller
   */
  processFactOutbound(targetPeriod = null) {
    const targetPeriodNorm = this._normalizePeriod(targetPeriod);
    Logger.log(`[FACT OUTBOUND] Bắt đầu tổng hợp Fact Outbound (Kỳ lọc: ${targetPeriodNorm || "ALL"})...`);

    const stgInfo = this.tableRepo.getDataByTableName("STG_SO_INVOICE");
    const stgRows = stgInfo ? stgInfo.values : [];
    if (!stgRows || stgRows.length <= 1) return 0;

    const stgPeriodIdx   = this._getColIndex("STG_SO_INVOICE", "period");
    const stgDateIdx     = this._getColIndex("STG_SO_INVOICE", "invoice_date");
    const stgCodeIdx     = this._getColIndex("STG_SO_INVOICE", "invoice_code");
    const stgLineIdx     = this._getColIndex("STG_SO_INVOICE", "line_no");
    const stgItemCodeIdx = this._getColIndex("STG_SO_INVOICE", "item_code");
    const stgQtyIdx      = this._getColIndex("STG_SO_INVOICE", "quantity");

    const validStgRows = [];
    for (let i = 1; i < stgRows.length; i++) {
      const r = stgRows[i];
      const rPeriodNorm = this._normalizePeriod(r[stgPeriodIdx]);
      const parentCode  = String(r[stgItemCodeIdx] || "").trim();
      const soldQty     = Number(r[stgQtyIdx]) || 0;

      if (targetPeriodNorm && rPeriodNorm !== targetPeriodNorm) continue;
      if (!parentCode || soldQty <= 0) continue;

      validStgRows.push(r);
    }

    if (validStgRows.length === 0) {
      Logger.log(`[FACT OUTBOUND] Không tìm thấy dữ liệu Staging SO thỏa mãn điều kiện kỳ [${targetPeriodNorm || "ALL"}].`);
      return 0;
    }

    const avgCostMap = this._buildAvgUnitCostMap();
    const allocationRulesMap = this._loadAllocationRules();

    const imInfo = this.tableRepo.getDataByTableName("ITEM_MASTER");
    const imRows = imInfo ? imInfo.values : [];
    const itemToIngrMap = {};

    if (imRows && imRows.length > 1) {
      const codeIdx = this._getColIndex("ITEM_MASTER", "item_code");
      const ingrIdx = this._getColIndex("ITEM_MASTER", "ingredient_code");
      for (let i = 1; i < imRows.length; i++) {
        const c = String(imRows[i][codeIdx] || "").trim();
        const ing = String(imRows[i][ingrIdx] || "").trim();
        if (c) itemToIngrMap[c] = ing;
      }
    }

    const factOutboundRows = [];
    const affectedPeriods = new Set();

    for (let i = 0; i < validStgRows.length; i++) {
      const r = validStgRows[i];
      const rPeriod    = String(r[stgPeriodIdx] || "").trim();
      const parentCode = String(r[stgItemCodeIdx] || "").trim();
      const soldQty    = Number(r[stgQtyIdx]) || 0;
      const transDate  = r[stgDateIdx];

      const overheadRate = this._resolveAllocationRate(transDate, rPeriod, allocationRulesMap);

      let explodedIngredients = [];
      if (this.bomService && typeof this.bomService.getExplodedRecipe === 'function') {
        explodedIngredients = this.bomService.getExplodedRecipe(parentCode, transDate);
      }

      if (explodedIngredients && explodedIngredients.length > 0) {
        explodedIngredients.forEach((ing, idx) => {
          const consumedQty  = soldQty * ing.norm_qty;
          const unitCost     = avgCostMap[ing.ingredient_code] || 0;
          const rawCost      = consumedQty * unitCost;
          const overheadCost = rawCost * overheadRate;
          const totalCost    = rawCost + overheadCost;

          factOutboundRows.push([
            rPeriod,
            transDate,
            r[stgCodeIdx],
            `${r[stgLineIdx]}_${idx + 1}`,
            parentCode,
            ing.ingredient_code,
            ing.depth || 1,
            soldQty,
            ing.norm_qty,
            ing.base_unit,
            consumedQty,
            unitCost,
            rawCost,
            overheadRate,
            overheadCost,
            totalCost
          ]);
        });
      } else {
        const targetIngrCode = itemToIngrMap[parentCode] || parentCode;
        const unitCost     = avgCostMap[targetIngrCode] || 0;
        const rawCost      = soldQty * unitCost;
        const overheadCost = rawCost * overheadRate;
        const totalCost    = rawCost + overheadCost;

        factOutboundRows.push([
          rPeriod,
          transDate,
          r[stgCodeIdx],
          String(r[stgLineIdx]),
          parentCode,
          targetIngrCode,
          0,
          soldQty,
          1,
          "kg",
          soldQty,
          unitCost,
          rawCost,
          overheadRate,
          overheadCost,
          totalCost
        ]);
      }

      if (rPeriod) affectedPeriods.add(rPeriod);
    }

    if (factOutboundRows.length > 0) {
      // 1. Tẩy sạch dữ liệu cũ thuộc các kỳ bị ảnh hưởng
      this._clearExistingFactDataByPeriods("FACT_OUTBOUND", affectedPeriods);

      // 2. Ghi mới dữ liệu dạng Append
      this.tableRepo.appendRowsByTableName("FACT_OUTBOUND", factOutboundRows);
      Logger.log(`[FACT OUTBOUND] Đã tạo thành công ${factOutboundRows.length} dòng dữ liệu cho các kỳ: ${Array.from(affectedPeriods).join(", ")}`);
    }

    return factOutboundRows.length;
  }

  _buildAvgUnitCostMap() {
    const factIn = this.tableRepo.getDataByTableName("FACT_INBOUND");
    const rows = factIn ? factIn.values : [];
    const totals = {};

    if (rows && rows.length > 1) {
      const ingIdx = this._getColIndex("FACT_INBOUND", "ingredient_code");
      const qtyIdx = this._getColIndex("FACT_INBOUND", "base_qty");
      const amtIdx = this._getColIndex("FACT_INBOUND", "amount");

      for (let i = 1; i < rows.length; i++) {
        const ing = String(rows[i][ingIdx] || "").trim();
        const q   = Number(rows[i][qtyIdx]) || 0;
        const a   = Number(rows[i][amtIdx]) || 0;

        if (ing && q > 0) {
          if (!totals[ing]) totals[ing] = { qty: 0, amt: 0 };
          totals[ing].qty += q;
          totals[ing].amt += a;
        }
      }
    }

    const avgMap = {};
    Object.keys(totals).forEach(ing => {
      avgMap[ing] = totals[ing].qty > 0 ? totals[ing].amt / totals[ing].qty : 0;
    });

    return avgMap;
  }

  _loadAllocationRules() {
    const rulesTable = this.tableRepo.getDataByTableName("OVERHEAD_ALLOCATION_RULE");
    const rows = rulesTable ? rulesTable.values : [];
    const list = [];

    if (rows && rows.length > 1) {
      const rateIdx = this._getColIndex("OVERHEAD_ALLOCATION_RULE", "allocation_rate");
      const fromIdx = this._getColIndex("OVERHEAD_ALLOCATION_RULE", "effective_from");
      const toIdx   = this._getColIndex("OVERHEAD_ALLOCATION_RULE", "effective_to");
      const actIdx  = this._getColIndex("OVERHEAD_ALLOCATION_RULE", "is_active");

      for (let i = 1; i < rows.length; i++) {
        const isActive = rows[i][actIdx] === true || String(rows[i][actIdx]).toUpperCase() === "TRUE";
        if (isActive) {
          list.push({
            rate: Number(rows[i][rateIdx]) || 0,
            effectiveFrom: rows[i][fromIdx] ? new Date(rows[i][fromIdx]) : new Date("1900-01-01"),
            effectiveTo: rows[i][toIdx] ? new Date(rows[i][toIdx]) : new Date("2099-12-31")
          });
        }
      }
    }
    return list;
  }

  _resolveAllocationRate(transDate, period, rules) {
    if (!rules || rules.length === 0) return 0;

    const targetDate = transDate ? new Date(transDate) : new Date();
    targetDate.setHours(0, 0, 0, 0);

    const matchedRule = rules.find(r => {
      const f = new Date(r.effectiveFrom); f.setHours(0, 0, 0, 0);
      const t = new Date(r.effectiveTo); t.setHours(0, 0, 0, 0);
      return targetDate >= f && targetDate <= t;
    });

    return matchedRule ? matchedRule.rate : 0;
  }

  _getColIndex(tableName, colKey) {
    if (!this.schemaService) return -1;
    const schemaMap = this.schemaService.getSchemaMap();
    const idx = this.schemaService.getColIndex(schemaMap, tableName, colKey);
    if (idx !== undefined && idx !== null && !isNaN(idx)) {
      const numIdx = Number(idx);
      return numIdx > 0 ? numIdx - 1 : numIdx;
    }
    return -1;
  }
}
