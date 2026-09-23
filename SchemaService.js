/**
 * Lớp dịch vụ quản lý cấu trúc lược đồ (Schema Service)
 */
class SchemaService {
  constructor() {
    this.ss = SpreadsheetApp.getActiveSpreadsheet();
  }

  /**
   * Đọc toàn bộ cấu trúc SCHEMA vào bộ nhớ dạng bản đồ tra cứu
   * @return {Object} Bản đồ chứa thông tin bảng và chỉ số cột
   */
  getSchemaMap() {
    const schemaSheet = this.ss.getSheetByName("SCHEMA");
    if (!schemaSheet) throw new Error("Không tìm thấy bảng cấu trúc SCHEMA trong Core Hub.");
    
    const data = schemaSheet.getDataRange().getValues();
    const schemaMap = {};
    
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const schemaName = row[0] ? row[0].toString().trim().toUpperCase() : ""; 
      const tableName = row[1] ? row[1].toString().trim() : "";
      
      // Đọc đúng vị trí: Cột C (index 2) là col_key, Cột D (index 3) là col_index (1-based)
      const colKey = row[2] ? row[2].toString().trim() : "";
      const colIndex = row[3] !== "" ? Number(row[3]) : -1;
      
      if (!schemaName) continue;
      
      if (!schemaMap[schemaName]) {
        schemaMap[schemaName] = {
          tableName: tableName,
          columns: {}
        };
      }
      if (colKey && colIndex !== -1) {
        // Lưu giữ nguyên giá trị 1-based từ schema, việc chuyển đổi 0-based sẽ thực hiện ở nơi cần dùng
        schemaMap[schemaName].columns[colKey] = colIndex;
      }
    }
    return schemaMap;
  }

  /**
   * Lấy tên Table thực tế dựa vào schema_name để truy xuất dữ liệu
   * @param {Object} schemaMap - Bản đồ cấu trúc schema
   * @param {string} schemaName - Tên lược đồ cần lấy tên bảng
   * @return {string} Tên thực tế của Google Sheets Table
   */
  getTableName(schemaMap, schemaName) {
    if (!schemaName) throw new Error("Thiếu tên schema_name cần tra cứu.");
    const normalizedName = String(schemaName).trim().toUpperCase();
    
    if (schemaMap && schemaMap[normalizedName]) {
      return schemaMap[normalizedName].tableName;
    }
    throw new Error(`Không tìm thấy schema_name: ${normalizedName} trong cấu hình SCHEMA.`);
  }

  /**
   * Lấy chỉ số cột (col_index bắt đầu từ 1) dựa trên schema_name và col_key
   * @param {Object} schemaMap - Bản đồ cấu trúc schema
   * @param {string} schemaName - Tên lược đồ
   * @param {string} colKey - Khóa cột cần tra cứu
   * @return {number} Chỉ số cột (từ 1) hoặc -1 nếu không tìm thấy
   */
  getColIndex(schemaMap, schemaName, colKey) {
    if (!schemaName || !colKey) return -1;
    const normalizedName = String(schemaName).trim().toUpperCase();
    
    if (schemaMap && schemaMap[normalizedName] && schemaMap[normalizedName].columns) {
      const index = schemaMap[normalizedName].columns[colKey];
      return index !== undefined ? index : -1;
    }
    return -1;
  }
}

/**
 * Các hàm wrapper toàn cục (Global wrapper functions) giữ tính tương thích 
 * tuân theo chuẩn đặt tên entityActionDescription.
 */
function schemaGetMap() {
  const service = new SchemaService();
  return service.getSchemaMap();
}

function schemaGetTableName(schemaMap, schemaName) {
  const service = new SchemaService();
  return service.getTableName(schemaMap, schemaName);
}

function schemaGetColIndex(schemaMap, schemaName, colKey) {
  const service = new SchemaService();
  return service.getColIndex(schemaMap, schemaName, colKey);
}