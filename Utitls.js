/**
 * Tự động quét tất cả các sheet trong file và tạo Bảng Danh mục Tables (SCHEMA_TABLES)
 */
function generateTablesCatalogSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const CATALOG_SHEET_NAME = "TABLES";
  
  // 1. Danh sách mô tả mặc định cho các bảng theo thiết kế hệ thống
  const defaultDescriptions = {
    "item_master": "Danh mục SKU Kho thực tế, quản lý ingredient_code (Mã BOM) và std_factor_to_base",
    "auto_map_rules": "Quy tắc Wildcard/Regex chuẩn hóa chính tả, từ vựng và biến thể tên gọi",
    "map_rules": "Bảng kết quả ánh xạ raw_name chứng từ sang item_code hệ thống",
    "unit_conversion": "Bảng tra cứu tỷ lệ quy đổi đơn vị tính nâng cao theo quy cách đóng gói",
    "recipe_bom": "Định mức công thức chế biến/sản xuất (quản lý theo ingredient_code)",
    "stg_po": "Dữ liệu Staging Hóa đơn / PO Mua hàng đầu vào",
    "stg_so": "Dữ liệu Staging Bán hàng / SO (dùng tính tiêu hao BOM lý thuyết)",
    "stg_inventory": "Dữ liệu Kiểm kê định kỳ thực tế đầu/cuối kỳ",
    "sys_config": "Cấu hình tham số hệ thống và cài đặt kỹ thuật",
    "unit_conversion": "Danh mục bảng quy đổi đơn vị tính",
    "TABLES": "Bảng Danh mục tất cả các Tables và Mô tả chức năng trong Hệ thống"
  };

  // 2. Kiểm tra nếu chưa có sheet SCHEMA_TABLES thì tạo mới
  let catalogSheet = ss.getSheetByName(CATALOG_SHEET_NAME);
  if (!catalogSheet) {
    catalogSheet = ss.insertSheet(CATALOG_SHEET_NAME, 0); // Đặt ở vị trí đầu tiên
  } else {
    catalogSheet.clear(); // Làm sạch nếu đã tồn tại để cập nhật mới
  }

  // 3. Lấy danh sách toàn bộ Sheet trong file
  const sheets = ss.getSheets();
  const catalogData = [
    ["STT", "Table Name (Sheet Name)", "Mục đích & Nhiệm vụ chính", "Loại Bảng (Group)", "Trạng thái"]
  ];

  sheets.forEach((sheet, index) => {
    const name = sheet.getName();
    let desc = defaultDescriptions[name] || "Sheet dữ liệu / Báo cáo nghiệp vụ";
    let group = "Nghiệp vụ / Báo cáo";
    
    // Phân loại nhóm bảng
    if (["item_master", "auto_map_rules", "map_rules", "unit_conversion", "recipe_bom"].includes(name)) {
      group = "Master Data / Rules";
    } else if (name.startsWith("stg_") || name.startsWith("raw_")) {
      group = "Staging / Transaction";
    } else if (name.startsWith("sys_") || name.startsWith("SCHEMA_")) {
      group = "System Config";
    }

    catalogData.push([
      index + 1,
      name,
      desc,
      group,
      "Đang hoạt động"
    ]);
  });

  // 4. Ghi dữ liệu vào sheet SCHEMA_TABLES
  const range = catalogSheet.getRange(1, 1, catalogData.length, catalogData[0].length);
  range.setValues(catalogData);

  // 5. Định dạng Giao diện (Formatting)
  catalogSheet.getRange(1, 1, 1, catalogData[0].length)
    .setBackground("#1b5e20")
    .setFontColor("#ffffff")
    .setFontWeight("bold")
    .setHorizontalAlignment("center");
    
  catalogSheet.getRange(2, 1, catalogData.length - 1, 1).setHorizontalAlignment("center");
  catalogSheet.setFrozenRows(1);
  catalogSheet.autoResizeColumns(1, catalogData[0].length);

  SpreadsheetApp.getUi().alert("Đã cập nhật danh mục Bảng thành công vào sheet 'SCHEMA_TABLES'!");
}