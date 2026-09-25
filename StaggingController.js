/**
 * [CONTROLLER] Chạy Staging PO với Prompt nhập Kỳ (YYYYMM) từ người dùng
 */
function runStagingPO() {
  const periodFilter = _promptUserForPeriod();
  if (periodFilter === null) return; // Người dùng bấm Cancel

  const poPrimaryKeys = ["invoice_code", "line_no"];
  const filters = periodFilter ? { period: periodFilter } : null;

  _executeStagingFlow("PO", poPrimaryKeys, filters);
}

/**
 * [CONTROLLER] Chạy Staging SO với Prompt nhập Kỳ (YYYYMM) từ người dùng
 */
function runStagingSO() {
  const periodFilter = _promptUserForPeriod();
  if (periodFilter === null) return; // Người dùng bấm Cancel

  const soPrimaryKeys = ["invoice_code", "line_no"];
  const filters = periodFilter ? { period: periodFilter } : null;

  _executeStagingFlow("SO", soPrimaryKeys, filters);
}

/**
 * Hộp thoại yêu cầu người dùng nhập Kỳ (YYYYMM)
 * @returns {string|null} Trả về chuỗi kỳ (VD: "202604"), "" nếu để trống (chạy tất cả), hoặc null nếu bấm Cancel
 */
function _promptUserForPeriod() {
  const ui = SpreadsheetApp.getUi();
  const result = ui.prompt(
    "Lọc dữ liệu Staging",
    "Nhập Kỳ cần lọc (định dạng YYYYMM, ví dụ: 202604).\nĐể trống nếu muốn chạy toàn bộ dữ liệu:",
    ui.ButtonSet.OK_CANCEL
  );

  const button = result.getSelectedButton();
  const text = result.getResponseText().trim();

  // Người dùng bấm Cancel hoặc đóng cửa sổ
  if (button !== ui.Button.OK) {
    Logger.log("[STAGING] Người dùng đã hủy thao tác.");
    return null;
  }

  // Nếu nhập giá trị, validate cơ bản 6 chữ số
  if (text !== "" && !/^\d{6}$/.test(text)) {
    ui.alert("Cảnh báo", "Kỳ nhập vào không đúng định dạng YYYYMM (ví dụ: 202604). Vui lòng thử lại!", ui.ButtonSet.OK);
    return null;
  }

  return text; // Trả về "202604" hoặc ""
}

/**
 * Điều phối chung luồng Staging
 * @param {string} sourceType - "PO" hoặc "SO"
 * @param {Array<string>} primaryKeys - Danh sách khóa chính
 * @param {Object} filters - Bộ lọc col_key
 */
function _executeStagingFlow(sourceType, primaryKeys, filters = null) {
  Logger.log(`=== BẮT ĐẦU CHẠY STAGING LAYER [${sourceType}] ===`);
  
  const tableRepo = new TableRepository(); 
  const schemaService = new SchemaService(tableRepo);
  const stagingService = new DataStagingService(tableRepo, schemaService);

  try {
    const targetStgName = sourceType === "PO" ? "stg_po_invoice" : "stg_so_invoice";

    // Thực thi staging với đúng tham số primaryKeys và filters
    const result = stagingService.runStaging(sourceType, primaryKeys, filters);

    Logger.log(`=== CHẠY STAGING ${sourceType} THÀNH CÔNG ===`);
    
    const filterInfo = filters && filters.period ? ` (Kỳ: ${filters.period})` : "";
    SpreadsheetApp.getUi().alert(
      "Thành công!", 
      `Đã chuyển đổi hoàn tất ${result.stgTransformedCount} dòng vào bảng ${targetStgName}${filterInfo}.`, 
      SpreadsheetApp.getUi().ButtonSet.OK
    );

    return result;

  } catch (error) {
    Logger.log(`[ERROR] Lỗi thực thi Staging ${sourceType}: ${error.message}`);
    SpreadsheetApp.getUi().alert("Lỗi", `Đã xảy ra lỗi: ${error.message}`, SpreadsheetApp.getUi().ButtonSet.OK);
    throw error;
  }
}

/**
 * Lớp điều khiển MenuUI (hoặc khai báo các function toàn cục)
 */
function menuRunAutoIngredientAll() {
  runAutoIngredientUI("ALL");
}

function menuRunAutoIngredientINT() {
  runAutoIngredientUI("PO");
}

function menuRunAutoIngredientOUT() {
  runAutoIngredientUI("SO");
}

/**
 * Hàm trung gian xử lý gọi Service và hiển thị UI Toast / Alert
 */
function runAutoIngredientUI(sourceGroup) {
  const ui = SpreadsheetApp.getUi();
  
  try {
    // Khởi tạo các Service phụ thuộc (sử dụng container/factory hiện tại của bạn)
    const tableRepo = new TableRepository();
    const schemaService = new SchemaService();
    const sysConfigService = new SysConfigService(tableRepo);
    const stagingService = new DataStagingService(tableRepo, schemaService, sysConfigService);

    SpreadsheetApp.getActiveSpreadsheet().toast("Đang kiểm tra và áp dụng quy tắc gán Mã Nguyên Liệu...", "Hệ Thống", 5);

    const count = stagingService.applyAutoIngredientCodesOnly(sourceGroup);

    if (count > 0) {
      ui.alert("Thành Công", `Đã cập nhật tự động ${count} mã nguyên liệu (ingredient_code) vào danh mục ITEM_MASTER.`, ui.ButtonSet.OK);
    } else {
      ui.alert("Thông Báo", "Không có mặt hàng nào mới được gán mã nguyên liệu (Tất cả đã có mã hoặc không khớp quy tắc nào).", ui.ButtonSet.OK);
    }

  } catch (error) {
    Logger.log(`[ERROR MENU AUTO INGREDIENT] ${error.message}`);
    ui.alert("Lỗi Thực Thi", `Chi tiết lỗi: ${error.message}`, ui.ButtonSet.OK);
  }
}
