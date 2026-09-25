/**
 * [SERVICE] InventoryService
 * Tính toán Tồn kho Đầu kỳ, Nhập, Xuất và Tồn kho Cuối kỳ theo từng kỳ báo cáo
 */
class InventoryService {
  constructor(tableRepo, schemaService) {
    this.tableRepo = tableRepo;
    this.schemaService = schemaService;
  }

  /**
   * TỔNG HỢP BẢNG TỒN KHO THEO KỲ (FACT_INVENTORY_BALANCE)
   * @param {Array<string>} periodsList - Danh sách các kỳ cần tính theo thứ tự (vd: ["2026-01", "2026-02"])
   */
  calculatePeriodicInventory(periodsList = []) {
    Logger.log("[INVENTORY] Bắt đầu tính toán tổng hợp tồn kho theo kỳ...");

    // 1. Lấy dữ liệu Tồn kho Ban đầu (Opening)
    const openingMap = this._loadOpeningBalance();

    // 2. Lấy dữ liệu Fact Inbound & Outbound
    const inboundData = this._loadFactInbound();
    const outboundData = this._loadFactOutbound();

    // Lấy tất cả các kỳ nếu không truyền tham số
    if (!periodsList || periodsList.length === 0) {
      const allPeriods = new Set([
        ...Object.keys(inboundData),
        ...Object.keys(outboundData)
      ]);
      periodsList = Array.from(allPeriods).sort();
    }

    // Map theo dõi số dư lũy kế qua từng kỳ: { ingredient_code: { qty, amount } }
    let runningBalance = { ...openingMap };

    const balanceRows = [];

    // 3. Duyệt qua từng kỳ theo thứ tự thời gian
    periodsList.forEach(period => {
      const inCurrentPeriod = inboundData[period] || {};
      const outCurrentPeriod = outboundData[period] || {};

      // Tập hợp tất cả các mã NVL phát sinh hoặc có tồn kho
      const allIngrCodes = new Set([
        ...Object.keys(runningBalance),
        ...Object.keys(inCurrentPeriod),
        ...Object.keys(outCurrentPeriod)
      ]);

      allIngrCodes.forEach(ingrCode => {
        // A. Đầu kỳ = Cuối kỳ trước (hoặc Opening Ban đầu)
        const openQty = runningBalance[ingrCode] ? runningBalance[ingrCode].qty : 0;
        const openAmt = runningBalance[ingrCode] ? runningBalance[ingrCode].amount : 0;

        // B. Nhập trong kỳ
        const inQty = inCurrentPeriod[ingrCode] ? inCurrentPeriod[ingrCode].qty : 0;
        const inAmt = inCurrentPeriod[ingrCode] ? inCurrentPeriod[ingrCode].amt : 0;

        // C. Đơn giá bình quân khả dụng trong kỳ (Weighted Avg Cost)
        const totalAvailQty = openQty + inQty;
        const totalAvailAmt = openAmt + inAmt;
        const avgUnitCost = totalAvailQty > 0 ? totalAvailAmt / totalAvailQty : 0;

        // D. Xuất trong kỳ
        const outQty = outCurrentPeriod[ingrCode] ? outCurrentPeriod[ingrCode].qty : 0;
        const outAmt = outQty * avgUnitCost; // Tính theo đơn giá bình quân

        // E. Tồn cuối kỳ
        const closeQty = openQty + inQty - outQty;
        const closeAmt = closeQty * avgUnitCost;

        // Lưu bản ghi kết quả
        balanceRows.push([
          period,
          ingrCode,
          openQty,
          openAmt,
          inQty,
          inAmt,
          outQty,
          outAmt,
          closeQty,
          avgUnitCost,
          closeAmt
        ]);

        // Cập nhật Số dư lũy kế cho kỳ tiếp theo
        runningBalance[ingrCode] = {
          qty: closeQty,
          amount: closeAmt
        };
      });
    });

    // 4. Lưu vào bảng FACT_INVENTORY_BALANCE
    if (balanceRows.length > 0) {
      this.tableRepo.upsertRowsByTableName("FACT_INVENTORY_BALANCE", balanceRows, ["period", "ingredient_code"]);
      Logger.log(`[INVENTORY] Đã cập nhật ${balanceRows.length} dòng vào FACT_INVENTORY_BALANCE.`);
    }

    return balanceRows.length;
  }



  
  /**
   * Cập nhật hàm _loadOpeningBalance trong InventoryService.js
   */
  _loadOpeningBalance() {
    // 1. Lấy bảng kiểm kê thô STG_INVENTORY_OPENING
    const stgTable = this.tableRepo.getDataByTableName("STG_INVENTORY_OPENING");
    const stgRows = stgTable ? stgTable.values : [];
  
    // 2. Load Mapping từ ITEM_MASTER (item_code -> ingredient_code & conversion_factor)
    const imTable = this.tableRepo.getDataByTableName("ITEM_MASTER");
    const imRows = imTable ? imTable.values : [];
    const itemMap = {};

    if (imRows && imRows.length > 1) {
      const codeIdx   = this._getColIndex("ITEM_MASTER", "item_code");
      const ingrIdx   = this._getColIndex("ITEM_MASTER", "ingredient_code");
      const factorIdx = this._getColIndex("ITEM_MASTER", "conversion_factor");

      for (let i = 1; i < imRows.length; i++) {
        const c   = String(imRows[i][codeIdx] || "").trim();
        const ing = String(imRows[i][ingrIdx] || "").trim();
        const f   = Number(imRows[i][factorIdx]) || 1;
        if (c) {
          itemMap[c] = {
            ingredient_code: ing || c, // Fallback về chính item_code nếu chưa set
            conversion_factor: f
          };
        }
      }
    }

    const openingMap = {}; // Tổng hợp lại theo ingredient_code

    if (stgRows && stgRows.length > 1) {
      const itemCodeIdx = this._getColIndex("STG_INVENTORY_OPENING", "item_code");
      const qtyIdx      = this._getColIndex("STG_INVENTORY_OPENING", "quantity");
      const costIdx     = this._getColIndex("STG_INVENTORY_OPENING", "unit_cost");
      const amtIdx      = this._getColIndex("STG_INVENTORY_OPENING", "amount");

      for (let i = 1; i < stgRows.length; i++) {
        const rawItemCode = String(stgRows[i][itemCodeIdx] || "").trim();
        const rawQty      = Number(stgRows[i][qtyIdx]) || 0;
        const rawCost     = Number(stgRows[i][costIdx]) || 0;
        const rawAmt      = Number(stgRows[i][amtIdx]) || (rawQty * rawCost);

        if (!rawItemCode) continue;

        // Quy đổi sang ingredient_code và base_qty
        const mappingInfo = itemMap[rawItemCode] || { ingredient_code: rawItemCode, conversion_factor: 1 };
        const ingrCode    = mappingInfo.ingredient_code;
        const factor      = mappingInfo.conversion_factor || 1;

        const baseQty = rawQty * factor;
        const baseAmt = rawAmt; // Thành tiền giữ nguyên

        // Gom nhóm lũy kế nếu nhiều mã INT_... cùng thuộc 1 ING_...
        if (!openingMap[ingrCode]) {
          openingMap[ingrCode] = { qty: 0, amount: 0 };
        }
        openingMap[ingrCode].qty += baseQty;
        openingMap[ingrCode].amount += baseAmt;
      }
    }

    return openingMap;
  }

  _loadFactInbound() {
    const table = this.tableRepo.getDataByTableName("FACT_INBOUND");
    const rows = table ? table.values : [];
    const result = {}; // { period: { ingrCode: { qty, amt } } }

    if (rows && rows.length > 1) {
      const pIdx   = this._getColIndex("FACT_INBOUND", "period");
      const ingIdx = this._getColIndex("FACT_INBOUND", "ingredient_code");
      const qtyIdx = this._getColIndex("FACT_INBOUND", "base_qty");
      const amtIdx = this._getColIndex("FACT_INBOUND", "amount");

      for (let i = 1; i < rows.length; i++) {
        const p   = String(rows[i][pIdx] || "").trim();
        const ing = String(rows[i][ingIdx] || "").trim();
        const q   = Number(rows[i][qtyIdx]) || 0;
        const a   = Number(rows[i][amtIdx]) || 0;

        if (p && ing) {
          if (!result[p]) result[p] = {};
          if (!result[p][ing]) result[p][ing] = { qty: 0, amt: 0 };
          result[p][ing].qty += q;
          result[p][ing].amt += a;
        }
      }
    }
    return result;
  }

  _loadFactOutbound() {
    const table = this.tableRepo.getDataByTableName("FACT_OUTBOUND");
    const rows = table ? table.values : [];
    const result = {}; // { period: { ingrCode: { qty } } }

    if (rows && rows.length > 1) {
      const pIdx   = this._getColIndex("FACT_OUTBOUND", "period");
      const ingIdx = this._getColIndex("FACT_OUTBOUND", "ingredient_code");
      const qtyIdx = this._getColIndex("FACT_OUTBOUND", "consumed_qty");

      for (let i = 1; i < rows.length; i++) {
        const p   = String(rows[i][pIdx] || "").trim();
        const ing = String(rows[i][ingIdx] || "").trim();
        const q   = Number(rows[i][qtyIdx]) || 0;

        if (p && ing) {
          if (!result[p]) result[p] = {};
          if (!result[p][ing]) result[p][ing] = { qty: 0 };
          result[p][ing].qty += q;
        }
      }
    }
    return result;
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
