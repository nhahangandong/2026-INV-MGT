/**
 * [CLASS] DataIngestionService - Tích hợp REST-projection và cơ chế lọc dữ liệu linh hoạt tổng quát
 */
class DataIngestionService {
  constructor(tableRepo) {
    this.tableRepo = tableRepo;
  }

  /**
   * Kéo dữ liệu từ Spoke với chuẩn REST-projection và cơ chế lọc động theo bất kỳ cột nào do Controller chỉ định
   * @param {string} spokeSpreadsheetId - ID file nguồn Spoke
   * @param {string} spokeSheetName - Tên sheet nguồn
   * @param {string} targetSchemaName - Tên schema đích (viết hoa, ví dụ: RAW_PO_INVOICE)
   * @param {Array<string>} keyColumns - Khóa chính để thực hiện upsert
   * @param {Object} [filter=null] - (Tùy chọn) Điều kiện lọc tổng quát do Controller quyết định. 
   *                                  Ví dụ: { columnKey: "period", values: ["202603", "202604"] }
   */
  ingestFromSpoke(spokeSpreadsheetId, spokeSheetName, targetSchemaName, keyColumns, filter = null) {
    const filterDesc = filter ? `[Filter by ${filter.columnKey}: ${filter.values.join(", ")}]` : "[Full Load]";
    Logger.log(`[DEBUG] Trích xuất từ Spoke [ID: ${spokeSpreadsheetId}] vào schema [${targetSchemaName}] ${filterDesc}`);

    // 1. Đọc dữ liệu từ file Spoke nguồn
    const spokeSs = SpreadsheetApp.openById(spokeSpreadsheetId);
    const spokeSheet = spokeSs.getSheetByName(spokeSheetName);
    if (!spokeSheet) {
      throw new Error(`[Ingestion] Không tìm thấy sheet nguồn '${spokeSheetName}' trong file Spoke.`);
    }

    const rawSpokeData = spokeSheet.getDataRange().getValues();
    if (!rawSpokeData || rawSpokeData.length <= 1) {
      Logger.log("[WARNING] File Spoke không có dữ liệu.");
      return;
    }

    const spokeRows = rawSpokeData.slice(1);

    // 2. Lấy định nghĩa từ SCHEMA thông qua TableRepository
    const schemaConfig = this.tableRepo.schemaMap[targetSchemaName.toUpperCase()];
    if (!schemaConfig) {
      throw new Error(`[Ingestion] Không tìm thấy cấu hình schema cho '${targetSchemaName}'.`);
    }

    const columnsMap = schemaConfig.columns; // Định dạng: { col_key: col_index_1_based }

    // 3. Sắp xếp các cột theo col_index tăng dần và chuyển về 0-based index (REST-style projection)
    const sortedKeys = Object.keys(columnsMap).sort((a, b) => columnsMap[a] - columnsMap[b]);
    const targetIndices = sortedKeys.map(key => columnsMap[key] - 1);

    // 4. Xử lý cơ chế lọc tổng quát nếu Controller có truyền vào điều kiện
    let filterColIndexInTarget = -1;
    let targetFilterValues = [];

    if (filter && filter.columnKey && filter.values && filter.values.length > 0) {
      // Tìm col_key trong SCHEMA (không phân biệt hoa thường)
      const matchedKey = Object.keys(columnsMap).find(k => k.toLowerCase() === filter.columnKey.toLowerCase());
      
      if (matchedKey) {
        const col1BasedIndex = columnsMap[matchedKey];
        // Xác định vị trí của cột đó trong mảng dữ liệu sau khi đã chiếu (targetIndices)
        filterColIndexInTarget = targetIndices.findIndex(idx => idx === (col1BasedIndex - 1));
        targetFilterValues = filter.values.map(v => String(v).trim());
      } else {
        Logger.log(`[WARNING] Không tìm thấy cột lọc '${filter.columnKey}' trong cấu hình SCHEMA.`);
      }
    }

    // 5. Chiếu dữ liệu (Projection) kết hợp lọc dòng tổng quát
    const processedRows = [];
    
    spokeRows.forEach(row => {
      // Nếu có điều kiện lọc và tìm thấy vị trí cột lọc hợp lệ
      if (filterColIndexInTarget !== -1 && targetFilterValues.length > 0) {
        const cellValue = row[targetIndices[filterColIndexInTarget]];
        const rowValueStr = cellValue !== undefined && cellValue !== null ? String(cellValue).trim() : "";
        
        // Kiểm tra xem giá trị của dòng có nằm trong danh sách cần lọc hay không
        if (!targetFilterValues.includes(rowValueStr)) {
          return; // Bỏ qua dòng không thỏa mãn
        }
      }

      // Lấy đúng các cột theo chuẩn REST-projection
      const projectedRow = targetIndices.map(colIdx => {
        return row[colIdx] !== undefined ? row[colIdx] : "";
      });

      processedRows.push(projectedRow);
    });

    // 6. Thực hiện Upsert dữ liệu sạch vào Hub
    if (processedRows.length > 0) {
      // Truyền nguyên mảng keyColumns (ví dụ: ["invoice_code", "line_no"]) thay vì chỉ lấy keyColumns[0]
      this.tableRepo.upsertRowsByTableName(targetSchemaName, processedRows, keyColumns);
      Logger.log(`[DEBUG] Đồng bộ thành công ${processedRows.length} dòng dữ liệu.`);
    } else {
      Logger.log("[WARNING] Không có dòng dữ liệu nào thỏa mãn điều kiện lọc.");
    }
  }
}