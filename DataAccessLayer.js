class TableRepository {
  constructor() {
    this.ss = SpreadsheetApp.getActiveSpreadsheet();
    this.spreadsheetId = this.ss.getId();
    this.schemaMap = schemaGetMap();
  }

  /**
   * Đọc dữ liệu dựa trên Google Sheets Table Name (table_name) chuẩn V2
   */
  getDataByTableName(schemaName) {
    const tableName = schemaGetTableName(this.schemaMap, schemaName);
    if (!tableName) {
      throw new Error(`[V2 Architecture] Không tìm thấy table_name cấu hình cho schema: ${schemaName}`);
    }

    const spreadsheet = Sheets.Spreadsheets.get(this.spreadsheetId, { includeGridData: false });
    let targetSheetName = null;
    let tableRange = null;

    if (spreadsheet.sheets) {
      for (const sheet of spreadsheet.sheets) {
        if (sheet.tables) {
          const foundTable = sheet.tables.find(t => t.name === tableName);
          if (foundTable) {
            targetSheetName = sheet.properties.title;
            tableRange = foundTable.range;
            break;
          }
        }
      }
    }

    if (!targetSheetName || !tableRange) {
      throw new Error(`[V2 Architecture] Không tìm thấy Google Sheets Table với tên: ${tableName}`);
    }

    const sheet = this.ss.getSheetByName(targetSheetName);
    const startRow = (tableRange.startRowIndex !== undefined ? tableRange.startRowIndex : 0) + 1;
    const startCol = (tableRange.startColumnIndex !== undefined ? tableRange.startColumnIndex : 0) + 1;
    
    // Tính toán số dòng thực tế trong phạm vi của Google Sheets Table
    const numRows = (tableRange.endRowIndex !== undefined ? tableRange.endRowIndex : sheet.getLastRow()) - startRow + 1;
    const numCols = (tableRange.endColumnIndex !== undefined ? tableRange.endColumnIndex : startCol) - startCol + 1;

    if (numRows <= 0 || numCols <= 0) {
      return {
        tableName: tableName,
        sheetName: targetSheetName,
        startRow: startRow,
        startCol: startCol,
        values: []
      };
    }

    const range = sheet.getRange(startRow, startCol, numRows, numCols);

    return {
      tableName: tableName,
      sheetName: targetSheetName,
      startRow: startRow,
      startCol: startCol,
      values: range.getValues()
    };
  }

  /**
   * Thêm dữ liệu hàng loạt (Append) vào GSheet Table chuẩn hàng loạt setValues
   */
  appendRowsByTableName(schemaName, rows) {
    if (!rows || rows.length === 0) return;

    const tableInfo = this.getDataByTableName(schemaName);
    const sheet = this.ss.getSheetByName(tableInfo.sheetName);
    
    if (!sheet) {
      throw new Error(`[V2 Architecture] Không tìm thấy sheet vật lý cho bảng: ${tableInfo.tableName}`);
    }

    const currentValues = tableInfo.values;
    // Vị trí dòng tiếp theo để ghi là: dòng bắt đầu của bảng + tổng số dòng hiện có trong bảng
    const nextRow = tableInfo.startRow + currentValues.length;
    const numCols = rows[0].length;

    // Ghi hàng loạt bằng setValues giúp tối ưu tốc độ và không giới hạn như appendRow
    sheet.getRange(nextRow, tableInfo.startCol, rows.length, numCols).setValues(rows);
  }

  /**
   * Thực thi UPSERT dữ liệu hàng loạt dựa trên col_key xác định (chuẩn V2 Schema-Driven)
   */
  upsertRowsByTableName(schemaName, newRows, uniqueKeyCols) {
    if (!newRows || newRows.length === 0) return;

    const tableInfo = this.getDataByTableName(schemaName);
    const data = tableInfo.values;

    // Chuẩn hóa danh sách khóa chính thành mảng
    const keyColsArray = Array.isArray(uniqueKeyCols) ? uniqueKeyCols : [uniqueKeyCols];

    // Lấy chính xác vị trí mảng (0-based index) hoàn toàn dựa vào col_index từ Schema
    const keyColIndices = keyColsArray.map(colKey => {
      const colIndex = schemaGetColIndex(this.schemaMap, schemaName, colKey);
      if (!colIndex || colIndex <= 0) {
        throw new Error(`[V2 Architecture] Không tìm thấy col_index hợp lệ cho col_key '${colKey}' trong schema '${schemaName}'`);
      }
      return colIndex - 1; // Chuyển col_index (1-based) sang mảng 0-based
    });

    // Hàm tạo chuỗi khóa tổ hợp duy nhất, ép kiểu string và trim để khớp tuyệt đối
    const makeRowKey = (row) => {
      return keyColIndices.map(colIdx => {
        const val = row[colIdx];
        return (val !== undefined && val !== null && val !== "") ? String(val).trim() : "";
      }).join("___"); // Sử dụng phân tách đặc biệt để tránh nhập nhằng chuỗi
    };

    // Đưa các khóa đã tồn tại trong Hub vào Set để tra cứu O(1)
    const existingKeys = new Set();
    for (let i = 0; i < data.length; i++) { // Bắt đầu từ 0 nếu data không chứa header hoặc 1 nếu có header
      const rowKey = makeRowKey(data[i]);
      // Kiểm tra khóa không được rỗng ở tất cả các thành phần
      if (rowKey && rowKey.split("___").every(part => part !== "")) { 
        existingKeys.add(rowKey);
      }
    }

    const rowsToAppend = [];
    newRows.forEach(row => {
      const rowKey = makeRowKey(row);
      // Kiểm tra xem dòng này đã tồn tại trong Hub hay chưa, đồng thời tránh trùng lặp trong chính đợt đẩy này
      if (rowKey && !existingKeys.has(rowKey)) {
        rowsToAppend.push(row);
        existingKeys.add(rowKey); 
      }
    });

    // Thực hiện ghi bổ sung dữ liệu mới
    if (rowsToAppend.length > 0) {
      this.appendRowsByTableName(schemaName, rowsToAppend);
      Logger.log(`[DEBUG] Upsert thành công ${rowsToAppend.length} dòng mới vào schema '${schemaName}'.`);
    } else {
      Logger.log(`[DEBUG] Không có dòng dữ liệu mới nào cần thêm vào schema '${schemaName}' (tất cả đã tồn tại).`);
    }
  }
  
  /**
   * Ghi đè toàn bộ dữ liệu (đã qua xử lý) trở lại Google Sheets Table
   * Rất hữu ích cho các tác vụ Transform hàng loạt in-memory.
   */
  updateTableData(schemaName, fullDataArray) {
    if (!fullDataArray || fullDataArray.length === 0) return;
    
    const tableInfo = this.getDataByTableName(schemaName);
    const sheet = this.ss.getSheetByName(tableInfo.sheetName);
    
    if (!sheet) {
      throw new Error(`[V2 Architecture] Không tìm thấy sheet vật lý cho bảng: ${tableInfo.tableName}`);
    }

    // Ghi đè lại toàn bộ mảng dữ liệu vào đúng vùng tọa độ của bảng
    sheet.getRange(tableInfo.startRow, tableInfo.startCol, fullDataArray.length, fullDataArray[0].length).setValues(fullDataArray);
  }

  
}