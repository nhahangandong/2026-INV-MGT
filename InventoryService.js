/**
 * [SERVICE] InventoryService
 * Tính toán báo cáo Xuất - Nhập - Tồn (FACT_INVENTORY_BALANCE)
 * Áp dụng cơ chế cuộn số dư chuyển tiếp kỳ N-1 -> N và Đơn giá Bình quân Gia quyền
 */
class InventoryService {
  constructor(tableRepo, schemaService) {
    this.tableRepo = tableRepo;
    this.schemaService = schemaService;
    this.schemaName = "FACT_INVENTORY_BALANCE";
  }

  /**
   * Tính toán và ghi nhận báo cáo N-X-T vào FACT_INVENTORY_BALANCE
   * @param {Array<string>|string|null} targetPeriods Danh sách kỳ cần lấy kết quả ghi (Ví dụ: ['202609'] hoặc null nếu ghi toàn bộ)
   */
  calculatePeriodicInventory(targetPeriods) {
    // 0. Khởi tạo schemaMap một lần duy nhất từ SchemaService
    const schemaMap = this.schemaService ? this.schemaService.getSchemaMap() : null;

    // Standardize targetPeriods
    let filterPeriods = null;
    if (targetPeriods) {
      if (Array.isArray(targetPeriods)) {
        filterPeriods = targetPeriods.map(p => this._normalizePeriod(p)).filter(Boolean);
      } else if (typeof targetPeriods === 'string' && targetPeriods.trim()) {
        filterPeriods = [this._normalizePeriod(targetPeriods)];
      }
    }

    // 1. Load toàn bộ dữ liệu từ các nguồn
    const stgOpening = this._loadStgOpening(schemaMap);
    const inboundData = this._loadFactInbound(schemaMap);
    const outboundData = this._loadFactOutbound(schemaMap);

    // 2. Gom tất cả danh sách các Kỳ xuất hiện trong hệ thống và sắp xếp tăng dần
    const allPeriodsSet = new Set(['202601']); // Kỳ đầu tiên mặc định từ STG_INVENTORY_OPENING
    Object.keys(inboundData).forEach(p => allPeriodsSet.add(p));
    Object.keys(outboundData).forEach(p => allPeriodsSet.add(p));
    if (filterPeriods) {
      filterPeriods.forEach(p => allPeriodsSet.add(p));
    }

    const sortedPeriods = Array.from(allPeriodsSet).sort();

    // 3. Gom tất cả các SKU xuất hiện ở bất kỳ nguồn nào
    const allSkusSet = new Set();
    Object.keys(stgOpening).forEach(sku => allSkusSet.add(sku));
    Object.values(inboundData).forEach(p => Object.keys(p).forEach(sku => allSkusSet.add(sku)));
    Object.values(outboundData).forEach(p => Object.keys(p).forEach(sku => allSkusSet.add(sku)));

    // Biến lưu số dư lũy kế chuyển tiếp: { SKU: { qty, amt, avgCost } }
    const runningBalance = {};

    // Khởi tạo runningBalance ban đầu (Kỳ đầu tiên)
    for (const sku of allSkusSet) {
      const init = stgOpening[sku] || { qty: 0, amt: 0 };
      runningBalance[sku] = {
        qty: init.qty,
        amt: init.amt,
        avgCost: init.qty > 0 ? (init.amt / init.qty) : 0
      };
    }

    const calculatedRowsByPeriod = {};

    // 4. Lặp qua từng kỳ theo thứ tự thời gian để lũy kế số dư
    for (const p of sortedPeriods) {
      const currentInbound = inboundData[p] || {};
      const currentOutbound = outboundData[p] || {};
      const periodRows = [];

      for (const sku of allSkusSet) {
        // Tồn đầu kỳ N = Tồn cuối kỳ N-1 (từ runningBalance)
        const openQty = runningBalance[sku].qty;
        const openAmt = runningBalance[sku].amt;

        // Phát sinh Nhập/Xuất trong kỳ N
        const inQty = currentInbound[sku] ? currentInbound[sku].qty : 0;
        const inAmt = currentInbound[sku] ? currentInbound[sku].amt : 0;

        const outQty = currentOutbound[sku] ? currentOutbound[sku].qty : 0;

        // Tính Đơn giá bình quân gia quyền cho kỳ N
        const totalQtyForAvg = openQty + inQty;
        const totalAmtForAvg = openAmt + inAmt;
        
        let avgUnitCost = runningBalance[sku].avgCost;
        if (totalQtyForAvg > 0) {
          avgUnitCost = totalAmtForAvg / totalQtyForAvg;
        }

        // Giá trị xuất kho = Số lượng xuất * Đơn giá bình quân
        const outAmt = outQty * avgUnitCost;

        // Tính Tồn cuối kỳ N
        const closeQty = openQty + inQty - outQty;
        const closeAmt = openAmt + inAmt - outAmt;

        // Cập nhật runningBalance cho kỳ N+1
        runningBalance[sku] = {
          qty: closeQty,
          amt: closeAmt,
          avgCost: avgUnitCost
        };

        // Bỏ qua các dòng không có số dư và không có phát sinh trong kỳ
        if (openQty !== 0 || openAmt !== 0 || inQty !== 0 || inAmt !== 0 || outQty !== 0 || closeQty !== 0) {
          periodRows.push([
            p,                // period
            sku,              // inventory_sku
            openQty,          // opening_qty
            openAmt,          // opening_amount
            inQty,            // inbound_qty
            inAmt,            // inbound_amount
            outQty,           // outbound_qty
            outAmt,           // outbound_amount
            closeQty,         // closing_qty
            avgUnitCost,      // avg_unit_cost
            closeAmt          // closing_amount
          ]);
        }
      }

      calculatedRowsByPeriod[p] = periodRows;
    }

    // 5. Ghi dữ liệu vào FACT_INVENTORY_BALANCE
    return this._saveToFactTable(calculatedRowsByPeriod, filterPeriods, schemaMap);
  }

  /**
   * Helper tra cứu dữ liệu từ TableRepository theo schemaName
   */
  _getTableData(schemaName) {
    if (!this.tableRepo) return null;
    try {
      return this.tableRepo.getDataByTableName(schemaName);
    } catch (e) {
      return null;
    }
  }

  /**
   * Đọc dữ liệu Tồn đầu kỳ từ STG_INVENTORY_OPENING (Kỳ 202601)
   */
  _loadStgOpening(schemaMap) {
    const itemMasterMap = this._loadItemMasterSkuMap(schemaMap);

    const table = this._getTableData("STG_INVENTORY_OPENING");
    const rows  = table ? table.values : [];
    const result = {}; // { inventory_sku: { qty, amt } }

    if (rows && rows.length > 1) {
      const itemCodeIdx = this._getColIndex(schemaMap, "STG_INVENTORY_OPENING", "item_code");
      const qtyIdx      = this._getColIndex(schemaMap, "STG_INVENTORY_OPENING", "quantity");
      const amtIdx      = this._getColIndex(schemaMap, "STG_INVENTORY_OPENING", "amount");

      for (let i = 1; i < rows.length; i++) {
        const itemCode = itemCodeIdx !== -1 ? String(rows[i][itemCodeIdx] || "").trim() : "";
        const q        = qtyIdx !== -1 ? Number(rows[i][qtyIdx]) || 0 : 0;
        const a        = amtIdx !== -1 ? Number(rows[i][amtIdx]) || 0 : 0;

        if (itemCode) {
          const sku = itemMasterMap[itemCode] || itemCode;

          if (!result[sku]) result[sku] = { qty: 0, amt: 0 };
          result[sku].qty += q;
          result[sku].amt += a;
        }
      }
    }
    return result;
  }

  /**
   * Helper tải bảng ITEM_MASTER để lập bản đồ ánh xạ item_code -> inventory_sku
   */
  _loadItemMasterSkuMap(schemaMap) {
    const table = this._getTableData("ITEM_MASTER");
    const rows  = table ? table.values : [];
    const skuMap = {}; // { item_code: inventory_sku }

    if (rows && rows.length > 1) {
      const itemCodeIdx = this._getColIndex(schemaMap, "ITEM_MASTER", "item_code");
      const invSkuIdx   = this._getColIndex(schemaMap, "ITEM_MASTER", "inventory_sku");

      if (itemCodeIdx !== -1 && invSkuIdx !== -1) {
        for (let i = 1; i < rows.length; i++) {
          const itemCode = String(rows[i][itemCodeIdx] || "").trim();
          const invSku   = String(rows[i][invSkuIdx] || "").trim();

          if (itemCode && invSku) {
            skuMap[itemCode] = invSku;
          }
        }
      }
    }
    return skuMap;
  }

  /**
   * Đọc dữ liệu Nhập kho từ FACT_INBOUND
   */
  _loadFactInbound(schemaMap) {
    const table = this._getTableData("FACT_INBOUND");
    const rows  = table ? table.values : [];
    const result = {}; // { period: { inventory_sku: { qty, amt } } }

    if (rows && rows.length > 1) {
      const pIdx   = this._getColIndex(schemaMap, "FACT_INBOUND", "period");
      const skuIdx = this._getColIndex(schemaMap, "FACT_INBOUND", "inventory_sku");
      
      let qtyIdx = this._getColIndex(schemaMap, "FACT_INBOUND", "base_qty");
      if (qtyIdx === -1) qtyIdx = this._getColIndex(schemaMap, "FACT_INBOUND", "quantity");

      const amtIdx = this._getColIndex(schemaMap, "FACT_INBOUND", "amount");

      for (let i = 1; i < rows.length; i++) {
        const p   = pIdx !== -1 ? this._normalizePeriod(rows[i][pIdx]) : "";
        const sku = skuIdx !== -1 ? String(rows[i][skuIdx] || "").trim() : "";
        const q   = qtyIdx !== -1 ? Number(rows[i][qtyIdx]) || 0 : 0;
        const a   = amtIdx !== -1 ? Number(rows[i][amtIdx]) || 0 : 0;

        if (p && sku) {
          if (!result[p]) result[p] = {};
          if (!result[p][sku]) result[p][sku] = { qty: 0, amt: 0 };
          result[p][sku].qty += q;
          result[p][sku].amt += a;
        }
      }
    }
    return result;
  }

  /**
   * Đọc dữ liệu Xuất kho từ FACT_OUTBOUND
   */
  _loadFactOutbound(schemaMap) {
    const table = this._getTableData("FACT_OUTBOUND");
    const rows  = table ? table.values : [];
    const result = {}; // { period: { inventory_sku: { qty } } }

    if (rows && rows.length > 1) {
      const pIdx = this._getColIndex(schemaMap, "FACT_OUTBOUND", "period");
      
      let skuIdx = this._getColIndex(schemaMap, "FACT_OUTBOUND", "child_item_code");
      if (skuIdx === -1) skuIdx = this._getColIndex(schemaMap, "FACT_OUTBOUND", "inventory_sku");

      let qtyIdx = this._getColIndex(schemaMap, "FACT_OUTBOUND", "consumed_qty");
      if (qtyIdx === -1) qtyIdx = this._getColIndex(schemaMap, "FACT_OUTBOUND", "quantity");

      for (let i = 1; i < rows.length; i++) {
        const p   = pIdx !== -1 ? this._normalizePeriod(rows[i][pIdx]) : "";
        const sku = skuIdx !== -1 ? String(rows[i][skuIdx] || "").trim() : "";
        const q   = qtyIdx !== -1 ? Number(rows[i][qtyIdx]) || 0 : 0;

        if (p && sku) {
          if (!result[p]) result[p] = {};
          if (!result[p][sku]) result[p][sku] = { qty: 0 };
          result[p][sku].qty += q;
        }
      }
    }
    return result;
  }

  /**
   * Lưu kết quả vào bảng FACT_INVENTORY_BALANCE qua TableRepository
   */
  _saveToFactTable(calculatedRowsByPeriod, filterPeriods, schemaMap) {
    const targetTable = this._getTableData(this.schemaName);
    const existingValues = targetTable ? targetTable.values : [];
    
    const defaultHeader = [
      "period", "inventory_sku", "opening_qty", "opening_amount",
      "inbound_qty", "inbound_amount", "outbound_qty", "outbound_amount",
      "closing_qty", "avg_unit_cost", "closing_amount"
    ];

    const header = (existingValues && existingValues.length > 0) ? existingValues[0] : defaultHeader;
    let rowsToWrite = [];

    if (filterPeriods && filterPeriods.length > 0) {
      const preservedRows = [];
      const pIdx = this._getColIndex(schemaMap, this.schemaName, "period");

      for (let i = 1; i < existingValues.length; i++) {
        const rowP = pIdx !== -1 ? this._normalizePeriod(existingValues[i][pIdx]) : "";
        if (!filterPeriods.includes(rowP)) {
          preservedRows.push(existingValues[i]);
        }
      }

      rowsToWrite = [...preservedRows];
      filterPeriods.forEach(p => {
        if (calculatedRowsByPeriod[p]) {
          rowsToWrite.push(...calculatedRowsByPeriod[p]);
        }
      });
    } else {
      Object.values(calculatedRowsByPeriod).forEach(periodRows => {
        rowsToWrite.push(...periodRows);
      });
    }

    const finalData = [header, ...rowsToWrite];
    
    // Sử dụng phương thức ghi dữ liệu chuẩn của DAL
    this.tableRepo.updateTableData(this.schemaName, finalData);

    return rowsToWrite.length;
  }

  /**
   * Helper gọi SchemaService.getColIndex và chuyển đổi 1-based index sang 0-based index
   */
  _getColIndex(schemaMap, schemaName, colKey) {
    if (!this.schemaService) return -1;
    
    let col1Based = -1;
    if (typeof this.schemaService.getColIndex === 'function') {
      col1Based = this.schemaService.getColIndex(schemaMap, schemaName, colKey);
    }

    return col1Based > 0 ? col1Based - 1 : -1;
  }

  _normalizePeriod(val) {
    if (!val) return "";
    const str = String(val).replace(/[^0-9]/g, "");
    return str.length >= 6 ? str.substring(0, 6) : str;
  }
}
