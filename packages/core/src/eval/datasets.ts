/**
 * Extra builtin memory eval datasets (v1.05, Team T6).
 *
 * Nối tiếp `memoryDataset.ts` (dataset Minh, 48 fact / 36 câu):
 * dataset thứ hai này đo cùng một bộ metric nhưng trên một miền
 * khác — bàn giao dự án ("project handover") — để runner có thể so
 * sánh điểm giữa các dataset và để regression không chỉ bị neo vào
 * một bộ fixture duy nhất.
 *
 * Như dataset đầu, toàn bộ nội dung là fixture hư cấu do open-bot
 * tự soạn (dự án "Cầu Vồng", người bàn giao hư cấu tên Phương,
 * người nhận tên Dũng), KHÔNG copy từ repo/dataset nào.
 */

import type { MemoryEvalDataset } from './memoryDataset';
import { BUILTIN_MEMORY_EVAL_DATASET } from './memoryDataset';

/**
 * Dataset bàn giao dự án: 24 fact, 18 câu hỏi (6 recall, 6
 * temporal, 6 multi-hop) về việc Phương bàn giao dự án Cầu Vồng
 * cho Dũng trong tháng 10/2026.
 */
export const HANDOVER_MEMORY_EVAL_DATASET: MemoryEvalDataset = {
  id: 'builtin-handover-v1',
  name: 'Builtin handover eval (fictional project Cau Vong)',
  version: 1,
  description:
    '24 fictional memory facts + 20 questions (8 recall, 6 temporal, 6 multi-hop) about a fictional project handover. Offline fixture only.',
  facts: [
    { id: 'h-01', text: 'Phuong is the outgoing tech lead of the Cau Vong project, a booking system for homestays in Hoi An.', tags: ['project', 'people'] },
    { id: 'h-02', text: 'Dung is the incoming tech lead who takes over Cau Vong from Phuong.', tags: ['project', 'people'] },
    { id: 'h-03', text: 'Cau Vong runs on Node.js with a Postgres database hosted on a single VPS.', tags: ['project', 'tools'] },
    { id: 'h-04', text: 'The Cau Vong deploy script lives at scripts/deploy.sh and needs the DEPLOY_KEY secret.', tags: ['project', 'tools'] },
    { id: 'h-05', text: 'Cau Vong sends booking confirmation emails through the MailJet service.', tags: ['project', 'tools'] },
    { id: 'h-06', text: 'The handover meeting happened on 2026-10-06 in the Da Nang office.', date: '2026-10-06', tags: ['meeting', 'handover'] },
    { id: 'h-07', text: 'On 2026-10-06 Phuong gave Dung the production database password in the vault.', date: '2026-10-06', tags: ['meeting', 'handover'] },
    { id: 'h-08', text: 'On 2026-10-06 Dung asked about the nightly backup job and Phuong showed him the cron entry.', date: '2026-10-06', tags: ['meeting', 'handover'] },
    { id: 'h-09', text: 'The nightly backup job runs at 02:00 and keeps 14 days of snapshots.', tags: ['project', 'tools'] },
    { id: 'h-10', text: 'On 2026-10-09 the Cau Vong payment webhook failed three times because of an expired certificate.', date: '2026-10-09', tags: ['incident', 'project'] },
    { id: 'h-11', text: 'On 2026-10-09 Dung renewed the certificate and the payment webhook recovered.', date: '2026-10-09', tags: ['incident', 'project'] },
    { id: 'h-12', text: 'The Cau Vong admin password rotates every 90 days; the next rotation is due 2026-11-15.', date: '2026-11-15', tags: ['project', 'security'] },
    { id: 'h-13', text: 'Phuong warned Dung that the search index rebuild takes about 40 minutes and locks the listings table.', tags: ['project', 'warning'] },
    { id: 'h-14', text: 'On 2026-10-13 Dung rebuilt the search index after adding Vietnamese tone-insensitive search.', date: '2026-10-13', tags: ['project'] },
    { id: 'h-15', text: 'On 2026-10-13 the search index rebuild finished in 38 minutes with no errors.', date: '2026-10-13', tags: ['project'] },
    { id: 'h-16', text: 'Cau Vong has 214 paying homestay hosts as of October 2026.', tags: ['project', 'business'] },
    { id: 'h-17', text: 'The biggest Cau Vong customer is a host group in Hoi An with 32 properties.', tags: ['project', 'business'] },
    { id: 'h-18', text: 'Phuong’s last working day on Cau Vong is 2026-10-30.', date: '2026-10-30', tags: ['handover', 'people'] },
    { id: 'h-19', text: 'On 2026-10-20 Dung fixed the double-booking bug that affected two hosts in Da Lat.', date: '2026-10-20', tags: ['project', 'incident'] },
    { id: 'h-20', text: 'The double-booking bug was caused by a missing unique index on the bookings table.', tags: ['project', 'incident'] },
    { id: 'h-21', text: 'Dung added the missing unique index on 2026-10-20 and verified it with a replay of October bookings.', date: '2026-10-20', tags: ['project', 'incident'] },
    { id: 'h-22', text: 'Cau Vong support replies to hosts within 4 working hours, a promise written in the service guide.', tags: ['project', 'business'] },
    { id: 'h-23', text: 'On 2026-10-27 Phuong and Dung recorded a 30-minute handover video for future maintainers.', date: '2026-10-27', tags: ['handover'] },
    { id: 'h-24', text: 'The handover video is stored in the team drive under Cau Vong / docs / handover-2026-10-27.mp4.', tags: ['handover'] },
  ],
  questions: [
    { id: 'hq-recall-01', category: 'recall', question: 'Who is taking over the Cau Vong project?', expectedFactIds: ['h-02'], expectedAnswerKeywords: ['Dung'] },
    { id: 'hq-recall-02', category: 'recall', question: 'What does Cau Vong use to send booking confirmation emails?', expectedFactIds: ['h-05'], expectedAnswerKeywords: ['MailJet'] },
    { id: 'hq-recall-03', category: 'recall', question: 'Where does the Cau Vong deploy script live?', expectedFactIds: ['h-04'], expectedAnswerKeywords: ['deploy.sh'] },
    { id: 'hq-recall-04', category: 'recall', question: 'How many paying homestay hosts does Cau Vong have?', expectedFactIds: ['h-16'], expectedAnswerKeywords: ['214'] },
    { id: 'hq-recall-05', category: 'recall', question: 'What did Phuong warn Dung about the search index rebuild?', expectedFactIds: ['h-13'], expectedAnswerKeywords: ['40 minutes', 'locks'] },
    { id: 'hq-recall-06', category: 'recall', question: 'How fast does Cau Vong support reply to hosts?', expectedFactIds: ['h-22'], expectedAnswerKeywords: ['4 working hours'] },
    { id: 'hq-recall-07', category: 'recall', question: 'Who is the outgoing tech lead of the Cau Vong project?', expectedFactIds: ['h-01'], expectedAnswerKeywords: ['Phuong'] },
    { id: 'hq-recall-08', category: 'recall', question: 'What stack does Cau Vong run on?', expectedFactIds: ['h-03'], expectedAnswerKeywords: ['Node.js', 'Postgres'] },
    { id: 'hq-temp-01', category: 'temporal', question: 'What happened at the handover meeting on 2026-10-06?', expectedFactIds: ['h-06', 'h-07', 'h-08'], expectedAnswerKeywords: ['handover', 'password'], expectedDate: '2026-10-06' },
    { id: 'hq-temp-02', category: 'temporal', question: 'What went wrong on 2026-10-09?', expectedFactIds: ['h-10', 'h-11'], expectedAnswerKeywords: ['webhook', 'certificate'], expectedDate: '2026-10-09' },
    { id: 'hq-temp-03', category: 'temporal', question: 'When is the next admin password rotation due?', expectedFactIds: ['h-12'], expectedAnswerKeywords: ['2026-11-15'], expectedDate: '2026-11-15' },
    { id: 'hq-temp-04', category: 'temporal', question: 'What did Dung do on 2026-10-13?', expectedFactIds: ['h-14', 'h-15'], expectedAnswerKeywords: ['search index', '38 minutes'], expectedDate: '2026-10-13' },
    { id: 'hq-temp-05', category: 'temporal', question: 'What did Dung fix on 2026-10-20?', expectedFactIds: ['h-19', 'h-21'], expectedAnswerKeywords: ['double-booking', 'unique index'], expectedDate: '2026-10-20' },
    { id: 'hq-temp-06', category: 'temporal', question: 'What is Phuong’s last working day on Cau Vong?', expectedFactIds: ['h-18'], expectedAnswerKeywords: ['2026-10-30'], expectedDate: '2026-10-30' },
    { id: 'hq-hop-01', category: 'multi-hop', question: 'The payment webhook failed — what caused it, and who fixed it?', expectedFactIds: ['h-10', 'h-11'], expectedAnswerKeywords: ['certificate', 'Dung'], hops: [['h-10'], ['h-11']] },
    { id: 'hq-hop-02', category: 'multi-hop', question: 'What caused the double-booking bug, and how did Dung fix it?', expectedFactIds: ['h-20', 'h-21'], expectedAnswerKeywords: ['unique index'], hops: [['h-20'], ['h-21']] },
    { id: 'hq-hop-03', category: 'multi-hop', question: 'When did the search index rebuild happen, and how long did it take?', expectedFactIds: ['h-14', 'h-15'], expectedAnswerKeywords: ['2026-10-13', '38 minutes'], hops: [['h-14'], ['h-15']] },
    { id: 'hq-hop-04', category: 'multi-hop', question: 'What did Phuong hand over on 2026-10-06, and where is the handover video?', expectedFactIds: ['h-07', 'h-23', 'h-24'], expectedAnswerKeywords: ['password', 'handover-2026-10-27'], hops: [['h-07'], ['h-23', 'h-24']] },
    { id: 'hq-hop-05', category: 'multi-hop', question: 'Cau Vong has a big customer in Hoi An — who is it, and how many hosts does the project have in total?', expectedFactIds: ['h-17', 'h-16'], expectedAnswerKeywords: ['32 properties', '214'], hops: [['h-17'], ['h-16']] },
    { id: 'hq-hop-06', category: 'multi-hop', question: 'The nightly backup runs at 02:00 — what did Dung ask about it at the handover meeting?', expectedFactIds: ['h-09', 'h-08'], expectedAnswerKeywords: ['02:00', 'cron'], hops: [['h-09'], ['h-08']] },
  ],
};

/** Mọi dataset fixture có sẵn (để runner/tool/UI liệt kê). */
export const BUILTIN_MEMORY_EVAL_DATASETS: readonly MemoryEvalDataset[] = [
  BUILTIN_MEMORY_EVAL_DATASET,
  HANDOVER_MEMORY_EVAL_DATASET,
];

/** Tìm dataset fixture theo id (null khi không có). */
export function getBuiltinMemoryEvalDataset(id: string): MemoryEvalDataset | null {
  return BUILTIN_MEMORY_EVAL_DATASETS.find((d) => d.id === id) ?? null;
}
