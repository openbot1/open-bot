/**
 * Memory eval dataset (v1.05, Team T6) — eval harness nội bộ cho memory
 * retrieval, kiểu LoCoMo/LongMemEval về HÌNH THỨC (câu hỏi nhiều loại +
 * metric recall/precision/F1 + temporal + multi-hop) nhưng dataset này
 * tự viết hoàn toàn: nhân vật, sự kiện, ngày tháng và câu hỏi đều là
 * fixture hư cấu do open-bot tự soạn, KHÔNG copy code/text/dataset hay
 * tài sản của bất kỳ repo nào, của xAI/Cursor hay của LoCoMo/LongMemEval.
 *
 * Chạy offline 100%: dataset là dữ liệu tĩnh trong file này; retriever
 * dùng mock embedding (xem memoryEval.ts), không gọi API ngoài, không
 * dùng key thật.
 *
 * Cấu trúc:
 * - `MemoryFact`: một mẩu ký ức (văn bản + ngày tháng tùy chọn + tag).
 * - `MemoryEvalQuestion`: một câu hỏi + ground truth là id các fact
 *   cần lấy được. Ba loại:
 *   - 'recall': lấy đúng fact chứa đáp án (đo recall/precision/F1);
 *   - 'temporal': câu hỏi gắn một ngày cụ thể — đáp án chỉ đúng khi
 *     fact lấy được mang đúng ngày đó (đo temporal accuracy);
 *   - 'multi-hop': đáp án cần N hop, mỗi hop là một nhóm fact; điểm
 *     multi-hop = số hop được phủ / tổng số hop.
 * - `BUILTIN_MEMORY_EVAL_DATASET`: bộ mặc định (48 fact, 36 câu hỏi,
 *   12 câu mỗi loại) về một người dùng hư cấu tên Minh.
 */

export interface MemoryFact {
  /** Id ổn định, dùng làm ground truth (`fact-01`, ...). */
  id: string;
  /** Nội dung ký ức, một câu ngắn, tự chứa đầy đủ thông tin. */
  text: string;
  /** Ngày của sự kiện (ISO `YYYY-MM-DD`), khi có. */
  date?: string;
  /** Tag tự do để lọc/nhóm (vd 'project', 'preference', 'travel'). */
  tags: string[];
}

export type MemoryEvalQuestionCategory = 'recall' | 'temporal' | 'multi-hop';

/** Một câu hỏi eval + ground truth của nó. */
export interface MemoryEvalQuestion {
  id: string;
  category: MemoryEvalQuestionCategory;
  /** Câu hỏi, viết như người dùng thật hỏi lại trợ lý. */
  question: string;
  /** Id các fact mà một retrieval tốt phải lấy được. */
  expectedFactIds: string[];
  /** Từ khóa đáp án (dùng cho mock LLM judge — xem memoryEval.ts). */
  expectedAnswerKeywords: string[];
  /** Ngày kỳ vọng — bắt buộc với câu 'temporal'. */
  expectedDate?: string;
  /**
   * Multi-hop: mỗi hop là một nhóm fact; một hop được tính là phủ
   * khi retrieval lấy được ít nhất một fact trong nhóm đó. Bỏ trống
   * = một hop duy nhất gồm toàn bộ expectedFactIds.
   */
  hops?: string[][];
}

export interface MemoryEvalDataset {
  id: string;
  name: string;
  version: number;
  description: string;
  facts: MemoryFact[];
  questions: MemoryEvalQuestion[];
}

function fact(id: string, text: string, date: string | undefined, tags: string[]): MemoryFact {
  return date ? { id, text, date, tags } : { id, text, tags };
}

function question(
  id: string,
  category: MemoryEvalQuestionCategory,
  q: string,
  expectedFactIds: string[],
  expectedAnswerKeywords: string[],
  extra?: { expectedDate?: string; hops?: string[][] },
): MemoryEvalQuestion {
  return {
    id,
    category,
    question: q,
    expectedFactIds,
    expectedAnswerKeywords,
    ...(extra?.expectedDate ? { expectedDate: extra.expectedDate } : {}),
    ...(extra?.hops ? { hops: extra.hops } : {}),
  };
}

/**
 * Bộ fixture mặc định — nhân vật hư cấu Minh, kỹ sư phần mềm ở Đà
 * Nẵng, làm dự án "Sao Mai", đi công tác Hà Nội, nuôi mèo tên Bún.
 * Mọi chi tiết đều do open-bot tự soạn cho mục đích eval nội bộ.
 */
export const BUILTIN_MEMORY_EVAL_DATASET: MemoryEvalDataset = {
  id: 'builtin-memory-v1',
  name: 'Builtin memory eval (fictional user Minh)',
  version: 1,
  description:
    '60 fictional memory facts + 61 questions (24 recall, 20 temporal, 17 multi-hop) about a fictional user. Offline fixture only — no real user data, no external calls.',
  facts: [
    // --- Sở thích & hồ sơ (recall) ---
    fact('fact-01', 'Minh prefers dark mode in every app and turns it on first after installing anything.', undefined, ['preference', 'profile']),
    fact('fact-02', 'Minh drinks black coffee with no sugar every morning before standup.', undefined, ['preference', 'profile']),
    fact('fact-03', 'Minh is allergic to peanuts and always checks food labels for peanut traces.', undefined, ['preference', 'health']),
    fact('fact-04', 'Minh speaks Vietnamese and English, and prefers meeting notes written in Vietnamese.', undefined, ['preference', 'profile']),
    fact('fact-05', 'Minh owns a cat named Bun, a grey tabby who sleeps on the keyboard during work calls.', undefined, ['profile', 'pet']),
    fact('fact-06', 'Minh dislikes phone calls and asks teammates to send a message first instead.', undefined, ['preference', 'profile']),
    // --- Dự án Sao Mai ---
    fact('fact-07', 'Minh leads the Sao Mai project, a dashboard for tracking delivery fleets in Da Nang.', undefined, ['project']),
    fact('fact-08', 'The Sao Mai project uses TypeScript on the frontend and Go on the backend.', undefined, ['project']),
    fact('fact-09', 'Lan joined the Sao Mai project as a designer on 2026-09-21.', '2026-09-21', ['project', 'people']),
    fact('fact-10', 'The Sao Mai launch deadline is 2026-12-01, decided at the planning meeting on 2026-09-02.', '2026-09-02', ['project']),
    fact('fact-11', 'Sao Mai stores fleet GPS data in PostgreSQL with a PostGIS extension.', undefined, ['project']),
    fact('fact-12', 'Minh reviews Sao Mai pull requests every Tuesday and Thursday morning.', undefined, ['project']),
    // --- Chuyến đi Hà Nội (temporal) ---
    fact('fact-13', 'Minh travelled to Hanoi on 2026-09-14 for a client workshop about Sao Mai.', '2026-09-14', ['travel', 'project']),
    fact('fact-14', 'On 2026-09-14 Minh met the client team at their office near Hoan Kiem Lake.', '2026-09-14', ['travel', 'meeting']),
    fact('fact-15', 'Minh returned from Hanoi on 2026-09-16 after the workshop ended.', '2026-09-16', ['travel']),
    fact('fact-16', 'During the Hanoi trip Minh tried egg coffee for the first time and liked it.', '2026-09-15', ['travel', 'preference']),
    fact('fact-17', 'Minh bought a silk scarf in Hanoi on 2026-09-15 as a gift for his mother.', '2026-09-15', ['travel']),
    // --- Họp & quyết định ---
    fact('fact-18', 'On 2026-09-02 the team decided the Sao Mai launch deadline is 2026-12-01.', '2026-09-02', ['meeting', 'project']),
    fact('fact-19', 'On 2026-09-08 Minh and Hoa agreed to postpone the mobile app to January 2027.', '2026-09-08', ['meeting', 'project']),
    fact('fact-20', 'On 2026-09-08 Hoa suggested adding offline mode to the Sao Mai mobile app.', '2026-09-08', ['meeting', 'project']),
    fact('fact-21', 'On 2026-10-05 Minh presented the Sao Mai demo to the investors in Ho Chi Minh City.', '2026-10-05', ['meeting', 'project']),
    fact('fact-22', 'On 2026-10-05 the investors asked for a weekly progress report every Friday.', '2026-10-05', ['meeting']),
    fact('fact-23', 'On 2026-10-12 Minh approved the new pricing page copy written by Thu.', '2026-10-12', ['meeting', 'people']),
    fact('fact-24', 'On 2026-10-12 Thu proposed renaming the "Fleet" tab to "Deliveries" in Sao Mai.', '2026-10-12', ['meeting', 'project']),
    // --- Người & nhóm ---
    fact('fact-25', 'Lan is a designer on the Sao Mai project who joined on 2026-09-21.', '2026-09-21', ['people', 'project']),
    fact('fact-26', 'Hoa is the product manager for Sao Mai and works from Hanoi.', undefined, ['people', 'project']),
    fact('fact-27', 'Thu writes copy for Sao Mai and prefers short sentences with no jargon.', undefined, ['people', 'project']),
    fact('fact-28', 'Minh mentors a junior developer named Khanh every Friday afternoon.', undefined, ['people']),
    fact('fact-29', 'Khanh joined Minh’s team on 2026-10-01 as a junior developer.', '2026-10-01', ['people']),
    fact('fact-30', 'On 2026-10-01 Khanh’s first task was fixing the login page redirect bug.', '2026-10-01', ['people', 'project']),
    // --- Sức khỏe & thói quen ---
    fact('fact-31', 'Minh runs 5 kilometres along the Han River every Saturday morning.', undefined, ['health', 'habit']),
    fact('fact-32', 'On 2026-09-19 Minh sprained his ankle while running and rested for one week.', '2026-09-19', ['health']),
    fact('fact-33', 'After the ankle sprain on 2026-09-19, Minh switched to swimming twice a week.', '2026-09-19', ['health', 'habit']),
    fact('fact-34', 'Minh takes vitamin D every morning since October 2026.', undefined, ['health']),
    // --- Tài chính & mua sắm ---
    fact('fact-35', 'Minh bought a mechanical keyboard on 2026-09-25 for 2,400,000 VND.', '2026-09-25', ['purchase']),
    fact('fact-36', 'Minh’s monthly budget for eating out is 3,000,000 VND.', undefined, ['finance']),
    fact('fact-37', 'On 2026-10-20 Minh paid the annual domain renewal for saomai.app, 450,000 VND.', '2026-10-20', ['finance', 'project']),
    fact('fact-38', 'Minh cancelled the music streaming subscription on 2026-10-03 to save money.', '2026-10-03', ['finance']),
    // --- Kỹ thuật & công cụ ---
    fact('fact-39', 'Minh’s laptop is a 14-inch machine with 32 GB of RAM running Linux.', undefined, ['tools']),
    fact('fact-40', 'Minh uses Neovim as the main code editor with a custom config stored in git.', undefined, ['tools']),
    fact('fact-41', 'The Sao Mai staging server restarts every night at 03:00 for backups.', undefined, ['project', 'tools']),
    fact('fact-42', 'On 2026-10-09 the Sao Mai staging server went down for two hours because of a disk failure.', '2026-10-09', ['project', 'incident']),
    fact('fact-43', 'On 2026-10-09 Minh restored the staging server from the nightly backup.', '2026-10-09', ['project', 'incident']),
    // --- Sở thích khác ---
    fact('fact-44', 'Minh’s favourite book is a worn copy of "The Pragmatic Programmer" on his desk.', undefined, ['preference']),
    fact('fact-45', 'Minh watches one documentary every Sunday evening and takes notes about it.', undefined, ['habit']),
    fact('fact-46', 'On 2026-09-27 Minh finished reading a book about distributed systems.', '2026-09-27', ['habit']),
    fact('fact-47', 'Minh plans to visit Da Lat in December 2026 for a short holiday.', undefined, ['travel']),
    fact('fact-48', 'Minh’s mother lives in Hue and calls him every Sunday at 20:00.', undefined, ['people', 'profile']),
    fact('fact-49', 'Minh’s sister lives in Singapore and visits Da Nang every Tet.', undefined, ['people', 'profile']),
    fact('fact-50', 'On 2026-11-02 Minh bought a standing desk for 5,800,000 VND.', '2026-11-02', ['purchase']),
    fact('fact-51', 'Minh’s team standup moved to 09:30 on Mondays starting November 2026.', undefined, ['project', 'meeting']),
    fact('fact-52', 'On 2026-11-03 the Sao Mai iOS build failed because the distribution certificate expired.', '2026-11-03', ['project', 'incident']),
    fact('fact-53', 'On 2026-11-03 Hoa renewed the iOS distribution certificate and the build passed.', '2026-11-03', ['project', 'incident']),
    fact('fact-54', 'Minh prefers working from the office on Tuesdays and from home on Fridays.', undefined, ['preference', 'habit']),
    fact('fact-55', 'On 2026-11-10 Minh gave a tech talk about event sourcing at the Da Nang dev meetup.', '2026-11-10', ['meeting']),
    fact('fact-56', 'Khanh’s probation review is scheduled for 2026-12-15.', '2026-12-15', ['people']),
    fact('fact-57', 'Minh keeps a paper notebook for sketching database schemas before coding.', undefined, ['habit', 'tools']),
    fact('fact-58', 'On 2026-10-28 Minh’s flight to Ho Chi Minh City was delayed by two hours due to fog.', '2026-10-28', ['travel']),
    fact('fact-59', 'The Sao Mai API rate limit is 1000 requests per minute per API key.', undefined, ['project']),
    fact('fact-60', 'Minh’s favourite lunch spot near the office is a bun cha stall on Bach Dang street.', undefined, ['preference']),
  ],
  questions: [
    // --- Recall (12) ---
    question('q-recall-01', 'recall', 'What is Minh allergic to?', ['fact-03'], ['peanut']),
    question('q-recall-02', 'recall', 'What does Minh drink every morning?', ['fact-02'], ['black coffee', 'no sugar']),
    question('q-recall-03', 'recall', 'What is the name of Minh’s cat?', ['fact-05'], ['Bun']),
    question('q-recall-04', 'recall', 'Which project does Minh lead?', ['fact-07'], ['Sao Mai']),
    question('q-recall-05', 'recall', 'What database does Sao Mai use for fleet GPS data?', ['fact-11'], ['PostgreSQL', 'PostGIS']),
    question('q-recall-06', 'recall', 'What does Minh dislike, phone calls or emails?', ['fact-06'], ['phone calls']),
    question('q-recall-07', 'recall', 'Who is the product manager for Sao Mai?', ['fact-26'], ['Hoa']),
    question('q-recall-08', 'recall', 'What is Minh’s monthly budget for eating out?', ['fact-36'], ['3,000,000']),
    question('q-recall-09', 'recall', 'Which editor does Minh use for coding?', ['fact-40'], ['Neovim']),
    question('q-recall-10', 'recall', 'What is Minh’s favourite book?', ['fact-44'], ['Pragmatic Programmer']),
    question('q-recall-11', 'recall', 'When does the Sao Mai staging server restart for backups?', ['fact-41'], ['03:00']),
    question('q-recall-12', 'recall', 'What does Minh do every Saturday morning?', ['fact-31'], ['runs', '5 kilometres', 'Han River']),
    // --- Temporal (12) ---
    question('q-temp-01', 'temporal', 'What did Minh do on 2026-09-14?', ['fact-13', 'fact-14'], ['Hanoi', 'workshop'], { expectedDate: '2026-09-14' }),
    question('q-temp-02', 'temporal', 'When did Minh travel to Hanoi for the client workshop?', ['fact-13'], ['2026-09-14', 'Hanoi'], { expectedDate: '2026-09-14' }),
    question('q-temp-03', 'temporal', 'What happened on 2026-09-19?', ['fact-32', 'fact-33'], ['sprained', 'ankle'], { expectedDate: '2026-09-19' }),
    question('q-temp-04', 'temporal', 'What was decided on 2026-09-02?', ['fact-18', 'fact-10'], ['2026-12-01', 'deadline'], { expectedDate: '2026-09-02' }),
    question('q-temp-05', 'temporal', 'What did Hoa suggest on 2026-09-08?', ['fact-20'], ['offline mode'], { expectedDate: '2026-09-08' }),
    question('q-temp-06', 'temporal', 'What happened on 2026-10-05?', ['fact-21', 'fact-22'], ['investors', 'demo'], { expectedDate: '2026-10-05' }),
    question('q-temp-07', 'temporal', 'What did Minh buy on 2026-09-25?', ['fact-35'], ['keyboard', '2,400,000'], { expectedDate: '2026-09-25' }),
    question('q-temp-08', 'temporal', 'When did Khanh join Minh’s team?', ['fact-29'], ['2026-10-01'], { expectedDate: '2026-10-01' }),
    question('q-temp-09', 'temporal', 'What went wrong on 2026-10-09?', ['fact-42', 'fact-43'], ['staging', 'disk failure'], { expectedDate: '2026-10-09' }),
    question('q-temp-10', 'temporal', 'What did Minh cancel on 2026-10-03?', ['fact-38'], ['music streaming'], { expectedDate: '2026-10-03' }),
    question('q-temp-11', 'temporal', 'What did Thu propose on 2026-10-12?', ['fact-24'], ['Deliveries'], { expectedDate: '2026-10-12' }),
    question('q-temp-12', 'temporal', 'What did Minh buy in Hanoi on 2026-09-15?', ['fact-17'], ['silk scarf'], { expectedDate: '2026-09-15' }),
    // --- Multi-hop (12) ---
    question(
      'q-hop-01', 'multi-hop',
      'Which project did Lan join, and when did she join it?',
      ['fact-09', 'fact-25'], ['Sao Mai', '2026-09-21'],
      { hops: [['fact-09'], ['fact-25']] },
    ),
    question(
      'q-hop-02', 'multi-hop',
      'Minh travelled to Hanoi and later a teammate joined his project — who joined, and which project?',
      ['fact-13', 'fact-09'], ['Lan', 'Sao Mai'],
      { hops: [['fact-13'], ['fact-09']] },
    ),
    question(
      'q-hop-03', 'multi-hop',
      'After spraining his ankle, what sport did Minh switch to, and how often?',
      ['fact-32', 'fact-33'], ['swimming', 'twice a week'],
      { hops: [['fact-32'], ['fact-33']] },
    ),
    question(
      'q-hop-04', 'multi-hop',
      'Who suggested offline mode, and what was decided about the mobile app on the same day?',
      ['fact-20', 'fact-19'], ['Hoa', 'January 2027'],
      { hops: [['fact-20'], ['fact-19']] },
    ),
    question(
      'q-hop-05', 'multi-hop',
      'What did the investors ask for after Minh’s demo, and when was the demo?',
      ['fact-21', 'fact-22'], ['weekly progress report', 'Friday'],
      { hops: [['fact-21'], ['fact-22']] },
    ),
    question(
      'q-hop-06', 'multi-hop',
      'What happened to the staging server, and how did Minh fix it?',
      ['fact-42', 'fact-43'], ['disk failure', 'backup'],
      { hops: [['fact-42'], ['fact-43']] },
    ),
    question(
      'q-hop-07', 'multi-hop',
      'Khanh joined the team and got a first task — what was the task, and when did he join?',
      ['fact-29', 'fact-30'], ['login page', '2026-10-01'],
      { hops: [['fact-29'], ['fact-30']] },
    ),
    question(
      'q-hop-08', 'multi-hop',
      'Minh bought a gift in Hanoi — what was it, and who was it for?',
      ['fact-17', 'fact-48'], ['silk scarf', 'mother'],
      { hops: [['fact-17'], ['fact-48']] },
    ),
    question(
      'q-hop-09', 'multi-hop',
      'Thu proposed a rename and Minh approved copy — what was renamed, and what did Minh approve?',
      ['fact-24', 'fact-23'], ['Deliveries', 'pricing page'],
      { hops: [['fact-24'], ['fact-23']] },
    ),
    question(
      'q-hop-10', 'multi-hop',
      'Minh runs on Saturdays — what happened during one run, and what did he switch to afterwards?',
      ['fact-31', 'fact-32', 'fact-33'], ['runs', 'sprained', 'swimming'],
      { hops: [['fact-31'], ['fact-32'], ['fact-33']] },
    ),
    question(
      'q-hop-11', 'multi-hop',
      'The Sao Mai deadline was decided at a planning meeting — when was the meeting, and what is the deadline?',
      ['fact-18', 'fact-10'], ['2026-09-02', '2026-12-01'],
      { hops: [['fact-18'], ['fact-10']] },
    ),
    question(
      'q-hop-12', 'multi-hop',
      'Minh cancelled a subscription to save money — what did he cancel, and what is his eating-out budget?',
      ['fact-38', 'fact-36'], ['music streaming', '3,000,000'],
      { hops: [['fact-38'], ['fact-36']] },
    ),
    question('q-recall-13', 'recall', 'Where does Minh’s sister live?', ['fact-49'], ['Singapore']),
    question('q-recall-14', 'recall', 'What is the Sao Mai API rate limit?', ['fact-59'], ['1000 requests per minute']),
    question('q-temp-13', 'temporal', 'What happened on 2026-11-03?', ['fact-52', 'fact-53'], ['iOS', 'certificate'], { expectedDate: '2026-11-03' }),
    question('q-temp-14', 'temporal', 'What did Minh buy on 2026-11-02?', ['fact-50'], ['standing desk', '5,800,000'], { expectedDate: '2026-11-02' }),
    question(
      'q-hop-13', 'multi-hop',
      'The Sao Mai iOS build failed — what caused it, and who fixed it?',
      ['fact-52', 'fact-53'], ['certificate', 'Hoa'],
      { hops: [['fact-52'], ['fact-53']] },
    ),
    question(
      'q-hop-14', 'multi-hop',
      'Minh works from the office on Tuesdays — where is his favourite lunch spot near the office?',
      ['fact-54', 'fact-60'], ['Tuesdays', 'bun cha'],
      { hops: [['fact-54'], ['fact-60']] },
    ),
    // --- Extra coverage questions (v1.05): every fact in the dataset
    // is asked about by at least one question (see eval/coverage.ts).
    question('q-recall-15', 'recall', 'What display mode does Minh prefer in every app?', ['fact-01'], ['dark mode']),
    question('q-recall-16', 'recall', 'Which languages does Minh speak, and which language does he prefer for meeting notes?', ['fact-04'], ['Vietnamese', 'English']),
    question('q-recall-17', 'recall', 'What languages does the Sao Mai project use on the frontend and backend?', ['fact-08'], ['TypeScript', 'Go']),
    question('q-recall-18', 'recall', 'Who writes copy for Sao Mai, and what style does she prefer?', ['fact-27'], ['Thu', 'short sentences']),
    question('q-recall-19', 'recall', 'What does Minh take every morning since October 2026?', ['fact-34'], ['vitamin D']),
    question('q-recall-20', 'recall', 'What kind of laptop does Minh use?', ['fact-39'], ['32 GB', 'Linux']),
    question('q-recall-21', 'recall', 'What does Minh do every Sunday evening?', ['fact-45'], ['documentary']),
    question('q-recall-22', 'recall', 'What does Minh keep a paper notebook for?', ['fact-57'], ['database schemas']),
    question('q-recall-23', 'recall', 'Where does Minh plan to go for a short holiday in December 2026?', ['fact-47'], ['Da Lat']),
    question('q-recall-24', 'recall', 'When is Minh’s team standup on Mondays?', ['fact-51'], ['09:30']),
    question('q-temp-15', 'temporal', 'When did Minh return from Hanoi?', ['fact-15'], ['2026-09-16'], { expectedDate: '2026-09-16' }),
    question('q-temp-16', 'temporal', 'What did Minh try for the first time on 2026-09-15?', ['fact-16'], ['egg coffee'], { expectedDate: '2026-09-15' }),
    question('q-temp-17', 'temporal', 'What did Minh pay for on 2026-10-20?', ['fact-37'], ['domain', '450,000'], { expectedDate: '2026-10-20' }),
    question('q-temp-18', 'temporal', 'What did Minh do on 2026-11-10?', ['fact-55'], ['tech talk', 'event sourcing'], { expectedDate: '2026-11-10' }),
    question('q-temp-19', 'temporal', 'What happened to Minh’s flight on 2026-10-28?', ['fact-58'], ['delayed', 'fog'], { expectedDate: '2026-10-28' }),
    question('q-temp-20', 'temporal', 'When is Khanh’s probation review scheduled?', ['fact-56'], ['2026-12-15'], { expectedDate: '2026-12-15' }),
    question(
      'q-hop-15', 'multi-hop',
      'When does Minh review pull requests, and when is the team standup on Mondays?',
      ['fact-12', 'fact-51'], ['Tuesday', '09:30'],
      { hops: [['fact-12'], ['fact-51']] },
    ),
    question(
      'q-hop-16', 'multi-hop',
      'Minh mentors Khanh every Friday — when is Khanh’s probation review?',
      ['fact-28', 'fact-56'], ['Friday', '2026-12-15'],
      { hops: [['fact-28'], ['fact-56']] },
    ),
    question(
      'q-hop-17', 'multi-hop',
      'Minh finished a book about distributed systems — what does he do every Sunday evening?',
      ['fact-46', 'fact-45'], ['distributed systems', 'documentary'],
      { hops: [['fact-46'], ['fact-45']] },
    ),
  ],
};

/** Validate a dataset (throws on any bad field). Pure — used by the runner and the tests. */
export function validateMemoryEvalDataset(raw: unknown): MemoryEvalDataset {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('memory eval dataset must be an object.');
  }
  const d = raw as Record<string, unknown>;
  if (typeof d.id !== 'string' || d.id.trim() === '') throw new Error('dataset needs a non-empty id.');
  if (typeof d.name !== 'string' || d.name.trim() === '') throw new Error('dataset needs a non-empty name.');
  if (typeof d.version !== 'number' || !Number.isInteger(d.version) || d.version < 1) {
    throw new Error('dataset version must be an integer >= 1.');
  }
  if (typeof d.description !== 'string') throw new Error('dataset description must be a string.');
  if (!Array.isArray(d.facts) || d.facts.length === 0) throw new Error('dataset needs at least one fact.');
  if (!Array.isArray(d.questions) || d.questions.length === 0) {
    throw new Error('dataset needs at least one question.');
  }
  const factIds = new Set<string>();
  for (const f of d.facts as Record<string, unknown>[]) {
    if (typeof f.id !== 'string' || f.id.trim() === '') throw new Error('fact needs a non-empty id.');
    if (factIds.has(f.id)) throw new Error(`duplicate fact id: ${f.id}`);
    factIds.add(f.id);
    if (typeof f.text !== 'string' || f.text.trim() === '') throw new Error(`fact ${f.id} needs non-empty text.`);
    if (f.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(f.date as string)) {
      throw new Error(`fact ${f.id} has a bad date (expected YYYY-MM-DD).`);
    }
    if (!Array.isArray(f.tags)) throw new Error(`fact ${f.id} needs a tags array.`);
  }
  const questionIds = new Set<string>();
  for (const q of d.questions as Record<string, unknown>[]) {
    if (typeof q.id !== 'string' || q.id.trim() === '') throw new Error('question needs a non-empty id.');
    if (questionIds.has(q.id)) throw new Error(`duplicate question id: ${q.id}`);
    questionIds.add(q.id);
    if (q.category !== 'recall' && q.category !== 'temporal' && q.category !== 'multi-hop') {
      throw new Error(`question ${q.id} has an unknown category.`);
    }
    if (typeof q.question !== 'string' || q.question.trim() === '') {
      throw new Error(`question ${q.id} needs non-empty question text.`);
    }
    if (!Array.isArray(q.expectedFactIds) || (q.expectedFactIds as unknown[]).length === 0) {
      throw new Error(`question ${q.id} needs at least one expectedFactId.`);
    }
    for (const fid of q.expectedFactIds as string[]) {
      if (!factIds.has(fid)) throw new Error(`question ${q.id} references unknown fact ${fid}.`);
    }
    if (!Array.isArray(q.expectedAnswerKeywords) || (q.expectedAnswerKeywords as unknown[]).length === 0) {
      throw new Error(`question ${q.id} needs at least one expectedAnswerKeyword.`);
    }
    if (q.category === 'temporal') {
      if (typeof q.expectedDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(q.expectedDate)) {
        throw new Error(`temporal question ${q.id} needs an expectedDate (YYYY-MM-DD).`);
      }
    }
    if (q.hops !== undefined) {
      if (!Array.isArray(q.hops) || (q.hops as unknown[]).length === 0) {
        throw new Error(`question ${q.id} has an empty hops array.`);
      }
      for (const hop of q.hops as string[][]) {
        if (!Array.isArray(hop) || hop.length === 0) throw new Error(`question ${q.id} has an empty hop.`);
        for (const fid of hop) {
          if (!factIds.has(fid)) throw new Error(`question ${q.id} hop references unknown fact ${fid}.`);
        }
      }
    }
  }
  return d as unknown as MemoryEvalDataset;
}

/** Facts of a dataset by id (helper for scorers and the UI). */
export function indexFactsById(dataset: MemoryEvalDataset): Map<string, MemoryFact> {
  return new Map(dataset.facts.map((f) => [f.id, f]));
}
