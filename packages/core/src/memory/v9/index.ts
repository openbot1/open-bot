/**
 * Memory v9 — barrel export (v1.08, Đội T1; mở rộng v1.09, Đội T2).
 *
 * Sleep-time compute nền tự động (daemon nối consolidation v8 +
 * trích fact v0.97 + snapshot block), git-backed versioning cho
 * block (snapshot / history gộp / diff từng dòng / rollback), và
 * shared-block registry (ACL theo bot, change feed, phát hiện xung
 * đột ghi đồng thời). Nối tiếp v6/v7/v8, không thay API cũ.
 *
 * v1.09 (Đội T2) thêm lớp kiểu Letta trên cùng nền đó: core memory tự
 * sửa qua tool (giới hạn cứng + cô đọng bắt buộc khi đầy), tầng
 * recall (tóm tắt phiên gần đây), tầng archival (kho dài hạn, tìm
 * kiếm từ khoá + embedding tuỳ chọn), thực thể agent bền vững
 * (snapshot/restore/export/import), đề xuất cập nhật core block lúc
 * sleep + sleep pass consolidation (dedupe + trích fact + propose).
 */
export * from './types';
export * from './sleepAgent';
export * from './versioning';
export * from './sharedRegistry';
export * from './condense';
export * from './coreMemory';
export * from './recall';
export * from './archival';
export * from './sleepProposals';
export * from './entity';
export * from './sleepConsolidation';
