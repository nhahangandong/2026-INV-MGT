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
    // Vị trí dòng tiếp theo để ghi
    const nextRow = tableInfo.startRow + currentValues.length;
    const numCols = rows[0].length;

    sheet.getRange(nextRow, tableInfo.startCol, rows.length, numCols).setValues(rows);
  }

  /**
   * Ghi đè toàn bộ dữ liệu trở lại Google Sheets Table (An toàn với bảng Rỗng)
   */
  updateTableData(schemaName, fullDataArray) {
    if (!fullDataArray || fullDataArray.length === 0) return;

    const tableInfo = this.getDataByTableName(schemaName);
    const sheet = this.ss.getSheetByName(tableInfo.sheetName);

    if (!sheet) {
      throw new Error(`[DAL] Không tìm thấy sheet cho bảng '${schemaName}'`);
    }

    const numRows = fullDataArray.length;
    const numCols = fullDataArray[0].length; // Lấy chính xác số cột của mảng DỮ LIỆU THỰC TẾ

    // Xóa bớt/Cập nhật Range ghi đè đúng kích thước mảng data
    sheet.getRange(tableInfo.startRow, tableInfo.startCol, numRows, numCols).setValues(fullDataArray);
  }

  /**
   * NÂNG CẤP: Thực thi UPSERT dữ liệu hàng loạt dựa trên khóa chính
   * - Nếu Khóa chính ĐÃ TỒN TẠI: Cập nhật (Overwrite) các cột mới vào dòng cũ.
   * - Nếu Khóa chính CHƯA TỒN TẠI: Thêm mới (Insert/Append) dòng dữ liệu.
   */
  /**
   * NÂNG CẤP CHUẨN INDEX: Thực thi UPSERT dữ liệu hàng loạt dựa trên khóa chính
   */
  upsertRowsByTableName(schemaName, newRows, uniqueKeyCols) {
    if (!newRows || newRows.length === 0) return;

    const tableInfo = this.getDataByTableName(schemaName);
    const fullValues = tableInfo.values;

    if (!fullValues || fullValues.length === 0) return;

    // Tách dòng Header (dòng 0) và phần Dữ liệu thực tế (từ dòng 1 trở đi)
    const headerRow = fullValues[0];
    const existingData = fullValues.slice(1);

    // Chuẩn hóa danh sách khóa chính
    const keyColsArray = Array.isArray(uniqueKeyCols) ? uniqueKeyCols : [uniqueKeyCols];

    // Lấy chỉ mục mảng (0-based index) từ Schema
    const keyColIndices = keyColsArray.map(colKey => {
      const colIndex = schemaGetColIndex(this.schemaMap, schemaName, colKey);
      if (!colIndex || colIndex <= 0) {
        throw new Error(`[V2 Architecture] Không tìm thấy col_index hợp lệ cho col_key '${colKey}' trong schema '${schemaName}'`);
      }
      return colIndex - 1;
    });

    // Tạo chuỗi khóa composite
    const makeRowKey = (row) => {
      return keyColIndices.map(colIdx => {
        const val = row[colIdx];
        return (val !== undefined && val !== null && val !== "") ? String(val).trim() : "";
      }).join("___");
    };

    // Ánh xạ chuỗi Khóa chính -> Chỉ số dòng trong mảng existingData (0-based)
    const existingRowIndexMap = new Map();
    for (let i = 0; i < existingData.length; i++) {
      const rowKey = makeRowKey(existingData[i]);
      if (rowKey && rowKey.split("___").every(part => part !== "")) {
        existingRowIndexMap.set(rowKey, i);
      }
    }

    let updatedCount = 0;
    let insertedCount = 0;

    // Duyệt qua dữ liệu mới để Update hoặc Insert
    newRows.forEach(newRow => {
      const rowKey = makeRowKey(newRow);
      if (!rowKey) return;

      if (existingRowIndexMap.has(rowKey)) {
        // [UPDATE] Khớp khóa -> Thay thế đúng dòng dữ liệu trong existingData
        const targetIdx = existingRowIndexMap.get(rowKey);
        existingData[targetIdx] = newRow;
        updatedCount++;
      } else {
        // [INSERT] Chưa có khóa -> Thêm vào cuối mảng existingData
        existingData.push(newRow);
        existingRowIndexMap.set(rowKey, existingData.length - 1);
        insertedCount++;
      }
    });

    // Ráp lại Header và Dữ liệu đã cập nhật trước khi ghi đè
    const finalTableData = [headerRow, ...existingData];

    if (updatedCount > 0 || insertedCount > 0) {
      this.updateTableData(schemaName, finalTableData);
      Logger.log(`[TableRepository] Upsert [${schemaName}] thành công: Cập nhật ${updatedCount} dòng, Thêm mới ${insertedCount} dòng.`);
    } else {
      Logger.log(`[TableRepository] [${schemaName}] Không có sự thay đổi dữ liệu.`);
    }
  }
}
