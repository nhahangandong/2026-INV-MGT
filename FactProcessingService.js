/**
 * [SERVICE] FactProcessingService.js
 * Xử lý ETL, bùng nổ BOM và tổng hợp Fact Data.
 * Tuân thủ quy ước V2 Schema-Driven & ghi dữ liệu thuần túy qua UPSERT.
 */
class FactProcessingService {
  constructor(tableRepo, schemaService, bomService = null) {
    this.tableRepo = tableRepo;
    this.schemaService = schemaService;
    this.bomService = bomService;
  }

  /**
   * Helper chuyển đổi col_index từ Schema (1-based) sang mảng JavaScript (0-based)
   * @param {string} tableName 
   * @param {string} colKey 
   * @returns {number} Chỉ số 0-based trong mảng JS, hoặc -1 nếu không tìm thấy
   */
  _getColIndex(tableName, colKey) {
    if (!this.schemaService) return -1;
    const schemaMap = this.schemaService.getSchemaMap();
    const colIndex1Based = this.schemaService.getColIndex(schemaMap, tableName, colKey);

    if (colIndex1Based !== undefined && colIndex1Based !== null && !isNaN(colIndex1Based)) {
      const numIdx = Number(colIndex1Based);
      return numIdx >= 1 ? numIdx - 1 : -1;
    }
    return -1;
  }

  /**
   * Chuẩn hóa chuỗi period về dạng thuần số để so sánh/lọc (VD: "2026-09" -> "202609")
   */
  _normalizePeriod(p) {
    if (p === null || p === undefined) return "";
    return String(p).replace(/[-_\s]/g, "").trim();
  }

  /**
   * Helper format hoặc ép kiểu ngày chứng từ về dạng Date hoặc String an toàn cho GSheet
   */
  _formatDateValue(rawDate) {
    if (!rawDate) return "";
    if (rawDate instanceof Date) return rawDate;
    const d = new Date(rawDate);
    return isNaN(d.getTime()) ? String(rawDate) : d;
  }

  /**
   * 1. Tổng hợp FACT_INBOUND từ STG_PO_INVOICE (Tuân thủ quy ước UPSERT)
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
      Logger.log(`[FACT INBOUND] Không tìm thấy dữ liệu Staging phù hợp cho kỳ [${targetPeriodNorm || "ALL"}].`);
      return 0;
    }

    // Mapping item_code -> ingredient_code từ ITEM_MASTER
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

    for (let i = 0; i < validStgRows.length; i++) {
      const r = validStgRows[i];
      const rPeriod   = String(r[stgPeriodIdx] || "").trim();
      const itemCode  = String(r[stgItemCodeIdx] || "").trim();
      const baseQty   = Number(r[stgBaseQtyIdx]) || 0;
      const basePrice = Number(r[stgBasePrcIdx]) || 0;
      const amount    = Number(r[stgAmtIdx]) || (baseQty * basePrice);
      const taxAmt    = Number(r[stgTaxAmtIdx]) || 0;
      const invDate   = this._formatDateValue(r[stgDateIdx]);

      const row = [
        rPeriod,
        invDate,
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
    }

    if (factInboundRows.length > 0) {
      // Thực thi UPSERT theo khóa chính kết hợp ["doc_code", "line_no", "item_code"]
      this.tableRepo.upsertRowsByTableName("FACT_INBOUND", factInboundRows, ["doc_code", "line_no", "item_code"]);
      Logger.log(`[FACT INBOUND] Thực thi UPSERT hoàn tất cho ${factInboundRows.length} dòng Fact Inbound.`);
    }

    return factInboundRows.length;
  }

  /**
   * 2. Tổng hợp FACT_OUTBOUND từ STG_SO_INVOICE (Tuân thủ quy ước UPSERT)
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

    if (validStgRows.length === 0) return 0;

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

    for (let i = 0; i < validStgRows.length; i++) {
      const r = validStgRows[i];
      const rPeriod    = String(r[stgPeriodIdx] || "").trim();
      const parentCode = String(r[stgItemCodeIdx] || "").trim();
      const soldQty    = Number(r[stgQtyIdx]) || 0;
      const transDate  = this._formatDateValue(r[stgDateIdx]);

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
    }

    if (factOutboundRows.length > 0) {
      // Thực thi UPSERT theo khóa chính kết hợp cho Fact Outbound
      this.tableRepo.upsertRowsByTableName("FACT_OUTBOUND", factOutboundRows, ["doc_code", "line_no", "parent_code", "ingredient_code"]);
      Logger.log(`[FACT OUTBOUND] Thực thi UPSERT hoàn tất cho ${factOutboundRows.length} dòng Fact Outbound.`);
    }

    return factOutboundRows.length;
  }

  /**
   * Helper: Tính giá vốn bình quân theo mã nguyên liệu từ FACT_INBOUND
   */
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

  /**
   * Helper: Tải danh sách quy tắc phân bổ chi phí chung theo Schema ALLOCATION_RULE
   */
  _loadAllocationRules() {
    const rulesTable = this.tableRepo.getDataByTableName("ALLOCATION_RULE");
    const rows = rulesTable ? rulesTable.values : [];
    const list = [];

    if (rows && rows.length > 1) {
      const rateIdx = this._getColIndex("ALLOCATION_RULE", "allocation_rate");
      const fromIdx = this._getColIndex("ALLOCATION_RULE", "effective_from");
      const toIdx   = this._getColIndex("ALLOCATION_RULE", "effective_to");
      const actIdx  = this._getColIndex("ALLOCATION_RULE", "is_active");

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

  /**
   * Helper: Tìm tỷ lệ phân bổ chi phí chung phù hợp với ngày chứng từ
   */
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
}
