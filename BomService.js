/**
 * Lớp Quản lý Định mức Công thức Đa cấp (Multi-level BOM / Recipe Service)
 * Hỗ trợ lưu trữ lịch sử áp dụng (SCD Type 2) và xả đệ quy theo thời gian/kỳ hạch toán.
 */
class BomService {
  /**
   * @param {TableRepository} tableRepo - Repository quản lý đọc/ghi dữ liệu bảng
   */
  constructor(tableRepo) {
    this.tableRepo = tableRepo;
  }

  // ==========================================
  // 1. BOOTSTRAP DỮ LIỆU BAN ĐẦU TỪ ITEM_MASTER
  // ==========================================

  /**
   * Khởi tạo danh mục BOM từ ITEM_MASTER (nhóm OUT/SO)
   * Đảm bảo kiểm tra Unique Key: (parent_item_code + child_item_code)
   * 
   * @returns {number} Số dòng BOM mới được chèn thêm
   */
  bootstrapBomFromItemMaster() {
    const itemMasterInfo = this.tableRepo.getDataByTableName("ITEM_MASTER");
    const bomInfo        = this.tableRepo.getDataByTableName("BOM_RECIPE");

    const itemRows = itemMasterInfo ? itemMasterInfo.values : [];
    const bomRows  = bomInfo ? bomInfo.values : [];

    if (!itemRows || itemRows.length <= 1) {
      Logger.log("[BOOTSTRAP BOM] Bảng ITEM_MASTER không có dữ liệu.");
      return 0;
    }

    // Lấy chỉ mục cột trên ITEM_MASTER
    const idxItemCode   = this._getColIdx(itemRows[0], "item_code");
    const idxItemName   = this._getColIdx(itemRows[0], "item_name");
    const idxSourceGrp  = this._getColIdx(itemRows[0], "source_grp");
    const idxIngredient = this._getColIdx(itemRows[0], "ingredient_code");
    const idxBaseUnit   = this._getColIdx(itemRows[0], "base_unit");

    // Lấy tập hợp Unique Keys (parent|child) đã tồn tại trong BOM_RECIPE
    const existingBomKeys = new Set();
    if (bomRows.length > 1) {
      const idxBomParent = this._getColIdx(bomRows[0], "parent_item_code");
      const idxBomChild  = this._getColIdx(bomRows[0], "child_item_code");

      for (let r = 1; r < bomRows.length; r++) {
        const parent = String(bomRows[r][idxBomParent] || "").trim();
        const child  = idxBomChild !== -1 ? String(bomRows[r][idxBomChild] || "").trim() : "";
        if (parent) {
          existingBomKeys.add(`${parent}|${child}`);
        }
      }
    }

    const newBomRows = [];
    const defaultFromDate = "2026-01-01";
    const defaultToDate   = "2099-12-31";

    for (let i = 1; i < itemRows.length; i++) {
      const row = itemRows[i];
      const sourceGrp = String(row[idxSourceGrp] || "").trim().toUpperCase();
      const itemCode  = String(row[idxItemCode] || "").trim();
      const itemName  = String(row[idxItemName] || "").trim();
      const ingCode   = idxIngredient !== -1 ? String(row[idxIngredient] || "").trim() : "";
      const baseUnit  = idxBaseUnit !== -1 ? String(row[idxBaseUnit] || "").trim() : "ĐĨA";

      // Lọc danh mục món bán (OUT/SO)
      if ((sourceGrp === "OUT" || sourceGrp === "SO") && itemCode) {
        const childCode = ingCode !== "" ? ingCode : "";
        const compositeKey = `${itemCode}|${childCode}`;

        if (!existingBomKeys.has(compositeKey)) {
          if (ingCode !== "") {
            // Kịch bản A: Món bán theo NVL / Bán thẳng (1-1)
            newBomRows.push([
              itemCode,           // parent_item_code
              ingCode,            // child_item_code
              1,                  // std_qty
              baseUnit,           // unit
              1,                  // bom_level
              true,               // is_leaf
              defaultFromDate,    // effective_from
              defaultToDate,      // effective_to
              true,               // is_active
              "Auto Bootstrap (Món bán theo NVL/Bán thẳng)" // note
            ]);
          } else {
            // Kịch bản B: Món chế biến phức tạp -> Tạo khung chờ nhập định mức
            newBomRows.push([
              itemCode,           // parent_item_code
              "",                 // child_item_code (chờ điền)
              0,                  // std_qty
              "KG",               // unit mặc định
              1,                  // bom_level
              true,               // is_leaf
              defaultFromDate,    // effective_from
              defaultToDate,      // effective_to
              false,              // is_active (False cho đến khi điền xong)
              "Auto Bootstrap (Chờ nhập định mức NVL con)" // note
            ]);
          }
          existingBomKeys.add(compositeKey);
        }
      }
    }

    // Ghi nối tiếp vào BOM_RECIPE
    if (newBomRows.length > 0) {
      const updatedBomTable = bomRows.concat(newBomRows);
      this.tableRepo.updateTableData("BOM_RECIPE", updatedBomTable);
      Logger.log(`[BOOTSTRAP BOM] Đã thêm ${newBomRows.length} dòng vào BOM_RECIPE.`);
    }

    return newBomRows.length;
  }

  // ==========================================
  // 2. THUẬT TOÁN ĐỆ QUY XẢ PHẲNG BOM ĐA CẤP
  // ==========================================

  /**
   * Xả phẳng món bán ra danh sách NVL thô cuối cùng theo thời điểm/kỳ hạch toán
   * 
   * @param {string} parentCode - Mã món bán (OUT) hoặc BTP cha
   * @param {number} parentQty - Số lượng món bán
   * @param {string|Date} targetTime - trans_date (VD: '2026-08-15') hoặc period (VD: '2026-01')
   * @returns {Array<{ingredientCode: string, totalQty: number, unit: string}>} Danh sách NVL thô
   */
  explodeBom(parentCode, parentQty = 1, targetTime = new Date()) {
    const targetDate = this._resolveTargetDate(targetTime);
    const bomMap = this._loadEffectiveBomMap(targetDate);
    const explodedResults = [];

    // Hàm đệ quy duyệt cây công thức
    const recurse = (currentParent, currentQty) => {
      const children = bomMap.get(currentParent) || [];

      // Node lá không có con trong BOM -> Coi chính nó là NVL thô
      if (children.length === 0) {
        explodedResults.push({
          ingredientCode: currentParent,
          totalQty: currentQty,
          unit: ""
        });
        return;
      }

      for (const child of children) {
        const reqQty = currentQty * child.stdQty;

        if (child.isLeaf || !bomMap.has(child.childItemCode)) {
          // Là nguyên liệu thô (Leaf Node)
          explodedResults.push({
            ingredientCode: child.childItemCode,
            totalQty: reqQty,
            unit: child.unit
          });
        } else {
          // Là Bán thành phẩm -> Đệ quy xả tiếp xuống cấp dưới
          recurse(child.childItemCode, reqQty);
        }
      }
    };

    recurse(parentCode, parentQty);

    // Gom nhóm các NVL trùng nhau sau đệ quy
    return this._consolidateIngredients(explodedResults);
  }

  // ==========================================
  // 3. TIỆN ÍCH HỖ TRỢ XỬ LÝ LỊCH SỬ & THỜI GIAN
  // ==========================================

  /**
   * Nạp toàn bộ BOM_RECIPE đang CÓ HIỆU LỰC tại thời điểm targetDate vào Map bộ nhớ
   */
  _loadEffectiveBomMap(targetDate) {
    const bomInfo = this.tableRepo.getDataByTableName("BOM_RECIPE");
    const bomRows = bomInfo ? bomInfo.values : [];
    const bomMap = new Map();

    if (!bomRows || bomRows.length <= 1) return bomMap;

    const idxParent = this._getColIdx(bomRows[0], "parent_item_code");
    const idxChild  = this._getColIdx(bomRows[0], "child_item_code");
    const idxQty    = this._getColIdx(bomRows[0], "std_qty");
    const idxUnit   = this._getColIdx(bomRows[0], "unit");
    const idxLeaf   = this._getColIdx(bomRows[0], "is_leaf");
    const idxFrom   = this._getColIdx(bomRows[0], "effective_from");
    const idxTo     = this._getColIdx(bomRows[0], "effective_to");
    const idxActive = this._getColIdx(bomRows[0], "is_active");

    for (let r = 1; r < bomRows.length; r++) {
      const row = bomRows[r];
      const parent = String(row[idxParent] || "").trim();
      const child  = String(row[idxChild] || "").trim();
      const qty    = Number(row[idxQty]) || 0;
      const unit   = String(row[idxUnit] || "").trim();
      const isLeaf = String(row[idxLeaf] || "").toLowerCase() === "true" || row[idxLeaf] === true;
      const isActive = String(row[idxActive] || "").toLowerCase() === "true" || row[idxActive] === true;

      if (!parent || !child || !isActive) continue;

      // Kiểm tra khoảng ngày hiệu lực (SCD Type 2)
      const effFrom = row[idxFrom];
      const effTo   = row[idxTo];

      if (this._isDateWithinRange(targetDate, effFrom, effTo)) {
        if (!bomMap.has(parent)) {
          bomMap.set(parent, []);
        }
        bomMap.get(parent).push({
          childItemCode: child,
          stdQty: qty,
          unit: unit,
          isLeaf: isLeaf
        });
      }
    }

    return bomMap;
  }

  /**
   * Chuyển đổi đầu vào (trans_date hoặc period) về chuẩn Ngày đối soát
   * Quy ước: Nếu truyền vào period (YYYY-MM), quy đổi về NGÀY CUỐI THÁNG.
   */
  _resolveTargetDate(timeInput) {
    if (timeInput instanceof Date) {
      return timeInput;
    }

    const str = String(timeInput || "").trim();

    // Nếu dạng period: "2026-01" hoặc "202601" (Độ dài <= 7)
    if (str.length <= 7) {
      const cleanStr = str.replace(/[^0-9]/g, "");
      if (cleanStr.length >= 6) {
        const year  = parseInt(cleanStr.substring(0, 4), 10);
        const month = parseInt(cleanStr.substring(4, 6), 10);
        // Trả về ngày cuối cùng của tháng
        return new Date(year, month, 0);
      }
    }

    // Trường hợp chuỗi trans_date tiêu chuẩn ("2026-08-15")
    const parsedDate = new Date(str);
    return isNaN(parsedDate.getTime()) ? new Date() : parsedDate;
  }

  /**
   * So sánh targetDate nằm trong khoảng [effFrom, effTo]
   */
  _isDateWithinRange(targetDate, effFrom, effTo) {
    const tDate = new Date(targetDate);
    const fDate = effFrom ? new Date(effFrom) : new Date("1900-01-01");
    const tToDate = effTo ? new Date(effTo) : new Date("2099-12-31");

    tDate.setHours(0, 0, 0, 0);
    fDate.setHours(0, 0, 0, 0);
    tToDate.setHours(0, 0, 0, 0);

    return tDate >= fDate && tDate <= tToDate;
  }

  /**
   * Gom nhóm danh sách NVL trùng nhau sau khi xả đệ quy
   */
  _consolidateIngredients(rawList) {
    const summaryMap = new Map();

    for (const item of rawList) {
      const key = item.ingredientCode;
      if (summaryMap.has(key)) {
        summaryMap.get(key).totalQty += item.totalQty;
      } else {
        summaryMap.set(key, {
          ingredientCode: item.ingredientCode,
          totalQty: item.totalQty,
          unit: item.unit || ""
        });
      }
    }

    return Array.from(summaryMap.values());
  }

  _getColIdx(headerRow, colKey) {
    if (!headerRow) return -1;
    return headerRow.findIndex(cell => String(cell || "").trim().toLowerCase() === colKey.toLowerCase());
  }
}
