class TestController {
  constructor() {
    // 1. Khởi tạo SchemaService và lấy schemaMap trước
    this.schemaService = new SchemaService();
    const schemaMap = this.schemaService.getSchemaMap();
    
    // 2. Khởi tạo TableRepository với schemaMap
    this.tableRepo = new TableRepository(schemaMap);
    
    // 3. Khởi tạo SysConfigService bằng cách truyền tableRepo vào
    this.sysConfigService = new SysConfigService(this.tableRepo);
    
    // 4. Khởi tạo DataIngestionService
    this.ingestionService = new DataIngestionService(this.tableRepo);
  }

  testDataIngestionFromSpoke() {
    Logger.log("[DEBUG] Bắt đầu chạy kiểm thử: testDataIngestionFromSpoke()");

    try {
      const spokeSpreadsheetId = this.sysConfigService.getConfig("SPOKE_PO_FILE_ID");
      const spokeSheetName = this.sysConfigService.getConfig("PO_SHEET_NAME");
      const targetSchemaName = this.sysConfigService.getConfig("RAW_PO_TABLE");
      
      const keyColumns = ["invoice_code", "line_no"]; 

      const filterCriteria = {
        columnKey: "period", 
        values: ["202609"] 
      };

      this.ingestionService.ingestFromSpoke(
        spokeSpreadsheetId,
        spokeSheetName,
        targetSchemaName,
        keyColumns,
        filterCriteria
      );

      Logger.log("[DEBUG] Kiểm thử trích xuất dữ liệu từ Spoke hoàn tất thành công.");

    } catch (error) {
      Logger.log(`[ERROR] Lỗi trong quá trình kiểm thử testDataIngestionFromSpoke: ${error.message}`);
      throw error;
    }
  }

  runAllTests() {
    Logger.log("----------------------------------------");
    Logger.log("[BAT DAU] CHAY BO KIEM THU HE THONG (MVC)");
    Logger.log("----------------------------------------");

    this.testDataIngestionFromSpoke();

    Logger.log("----------------------------------------");
    Logger.log("[HOAN TAT] TOAN BO KIEM THU");
    Logger.log("----------------------------------------");
  }
}

function runSystemTestSuites() {
  const controller = new TestController();
  controller.runAllTests();
}



/**
 * [TEST] Kịch bản kiểm thử cho DataStagingService
 */
function testDataStagingService() {
  Logger.log("=== BẮT ĐẦU CHẠY UNIT TEST CHO DATA STAGING SERVICE ===");

  // 1. Mock TableRepo để giả lập dữ liệu trả về từ các bảng
  const mockTableRepo = {
    // Giả lập dữ liệu đọc từ bảng SCHEMA hoặc cấu hình (nếu cần)
    readTable: function(schemaName) {
      if (schemaName === "RAW_PO") {
        return [
          // [period, invoice_code, invoice_date, line_no, raw_name, tax_rate, unit, quantity, price, amount, tax_amount]
          ["2026-04", "INV-001", "2026-04-10", 1, "Cá hồi tươi Nauy Fillet", 0.05, "Kg", "10", "300000", "3000000", "150000"],
          ["2026-04", "INV-001", "2026-04-10", 2, "Bia Carlsberg keg", 0.1, "keg", "-", "-", "-", "-"], // Test trường hợp số liệu thô là "-"
          ["2026-04", "INV-002", "2026-04-11", 1, "Ba chỉ bò cuộn 450G", "KKKNT", "Khay", "5", "65000", "325000", "0"]
        ];
      }
      if (schemaName === "MAP_RULES") {
        return [
          // [source_grp, raw_name, item_name, item_code]
          ["INT", "Cá hồi tươi Nauy Fillet", "Ca hoi tuoi Nauy Fillet", "INT_CA_HOI_NAUY"],
          ["INT", "Bia Carlsberg keg", "Bia Carlsberg Keg 30L", "INT_BIA_CARLSBERG_KEG"],
          ["INT", "Ba chỉ bò cuộn 450G", "Ba chi bo cuon 450G", "INT_BA_CHI_BO_CUON"]
        ];
      }
      if (schemaName === "UNIT_CONVERSION") {
        return [
          // [source_grp, item_code, alt_unit, base_unit, conversion_factor]
          ["INT", "INT_CA_HOI_NAUY", "Kg", "Gram", 1000],          // 1 Kg = 1000 Gram
          ["INT", "INT_BIA_CARLSBERG_KEG", "keg", "Lít", 30],       // 1 keg = 30 Lít
          ["INT", "INT_BA_CHI_BO_CUON", "Khay", "Gram", 450]       // 1 Khay = 450 Gram
        ];
      }
      return [];
    },

    // Giả lập hàm ghi nhận kết quả xuống bảng Staging
    writeTable: function(schemaName, rows) {
      Logger.log(`[MOCK WRITE] Ghi thành công ${rows.length} dòng vào bảng: ${schemaName}`);
      
      // In chi tiết dữ liệu dòng đầu tiên để kiểm tra kết quả biến đổi
      if (rows.length > 0) {
        Logger.log("--- DỮ LIỆU MẪU DÒNG 1 SAU KHI STAGING ---");
        Logger.log(`- Mã hóa đơn: ${rows[0][1]} | Tên thô: ${rows[0][4]} -> Tên chuẩn: ${rows[0][5]} [Mã: ${rows[0][6]}]`);
        Logger.log(`- Số lượng thô: ${rows[0][9]} ${rows[0][8]} -> Số lượng cơ sở: ${rows[0][15]} ${rows[0][13]} (Hệ số: ${rows[0][14]})`);
        Logger.log(`- Đơn giá thô: ${rows[0][10]} -> Đơn giá cơ sở: ${rows[0][16]}`);
      }

      if (rows.length > 1) {
        Logger.log("--- DỮ LIỆU MẪU DÒNG 2 (TEST LÀM SẠCH KÝ TỰ '-') ---");
        Logger.log(`- Tên thô: ${rows[1][4]} | Số lượng làm sạch: ${rows[1][9]} | Thành tiền: ${rows[1][11]}`);
      }
    }
  };

  // 2. Khởi tạo Service với Repository giả lập
  const stagingService = new DataStagingService(mockTableRepo, null);

  // 3. Thực thi chạy Staging
  try {
    stagingService.runStaging("PO");
    Logger.log("=== UNIT TEST HOÀN TẤT THÀNH CÔNG ===");
  } catch (error) {
    Logger.log(`[ERROR UNIT TEST] Lỗi thực thi: ${error.message} - Stack: ${error.stack}`);
  }
}