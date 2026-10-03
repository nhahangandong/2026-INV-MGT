/**
 * [CONTROLLER] InventoryController
 * Xử lý luồng tổng hợp báo cáo N-X-T Tồn kho
 */

function runInventoryBalanceFlow() {
  const ui = SpreadsheetApp.getUi();
  
  // 1. Nhập kỳ báo cáo (Ví dụ: 202604 hoặc để trống để chạy tất cả các kỳ)
  const response = ui.prompt(
    "Tổng hợp Báo cáo Xuất - Nhập - Tồn",
    "Nhập kỳ báo cáo theo định dạng YYYYMM (VD: 202604).\nĐể trống nếu muốn chạy tính toán cho TẤT CẢ các kỳ:",
    ui.ButtonSet.OK_CANCEL
  );

  if (response.getSelectedButton() !== ui.Button.OK) {
    return; // Người dùng nhấn Cancel
  }

  const inputPeriod = response.getResponseText().trim();
  const periods = inputPeriod ? [inputPeriod] : null;

  try {
    // 2. Khởi tạo Dependencies
    const tableRepo = new TableRepository();
    const schemaService = new SchemaService(tableRepo);
    const inventoryService = new InventoryService(tableRepo, schemaService);

    Logger.log(`=== BẮT ĐẦU CHẠY BÁO CÁO TỒN KHO [Kỳ: ${inputPeriod || "TOÀN BỘ"}] ===`);

    // 3. Thực thi tính toán
    const updatedCount = inventoryService.calculatePeriodicInventory(periods);

    const periodMsg = inputPeriod ? `cho kỳ [${inputPeriod}]` : "cho toàn bộ các kỳ";

    if (updatedCount > 0) {
      ui.alert(
        "Thành Công!",
        `Đã tổng hợp hoàn tất ${updatedCount} dòng dữ liệu N-X-T ${periodMsg} vào bảng FACT_INVENTORY_BALANCE.`,
        ui.ButtonSet.OK
      );
    } else {
      ui.alert(
        "Thông Báo",
        `Không có dữ liệu phát sinh hoặc tồn kho nào được ghi nhận ${periodMsg}.`,
        ui.ButtonSet.OK
      );
    }

  } catch (error) {
    Logger.log(`[ERROR] Lỗi thực thi Báo cáo Tồn kho: ${error.message}`);
    ui.alert(
      "Lỗi Thực Thi",
      `Chi tiết lỗi: ${error.message}`,
      ui.ButtonSet.OK
    );
  }
}
