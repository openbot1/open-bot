/**
 * Vision fallback — click theo tọa độ khi element không có trong
 * accessibility tree (v1.33, Đội T4).
 *
 * Khi nào cần: element không có role ARIA (canvas, SVG thuần, div vẽ
 * bằng CSS, custom widget không gán role) thì `findNodeByRef` trả null
 * và model không có ref để click. Lúc đó driver chụp screenshot, model
 * (hoặc heuristic) trả về tọa độ (x, y) trong viewport, và fallback này
 * thực thi click tại tọa độ đó — với các rào chắn:
 *
 *  - Tọa độ phải nằm trong viewport (0 <= x < width, 0 <= y < height);
 *    ngoài viewport = lỗi rõ ràng, không click mù.
 *  - Ghi lại bounding box của lần click cuối + screenshot liên quan để
 *    audit/debug (element nào, ở đâu, khi nào).
 *  - Hỗ trợ "element registry": driver thật có thể đăng ký bbox của
 *    các element không-role (vd từ `getBoundingClientRect`) để model
 *    click bằng tên thay vì đoán tọa độ.
 *  - Click tọa độ luôn được đánh dấu `viaVision: true` trong step log
 *    để eval phân biệt success qua a11y-tree vs qua vision fallback.
 *
 * Module này không gọi Playwright — nó validate + ghi sổ; driver thật
 * truyền vào một `CoordinateClicker` (Playwright `page.mouse.click`).
 */

export interface ViewportSize {
  width: number;
  height: number;
}

/** Hàm click tọa độ do driver thật cung cấp. */
export type CoordinateClicker = (x: number, y: number, opts?: { button?: 'left' | 'right' | 'middle' }) => Promise<void>;

/** Bounding box của một element (viewport coordinates, CSS pixels). */
export interface ElementBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Một element không-role đã đăng ký bbox (để click bằng tên). */
export interface RegisteredVisualElement {
  /** Tên do caller đặt (vd `canvas-chart`, `svg-map-pin`). */
  name: string;
  box: ElementBox;
  /** Mô tả ngắn cho model (vd "biểu đồ giá, bấm để xem chi tiết"). */
  description?: string;
  registeredAt: number;
}

/** Bản ghi một lần click tọa độ (audit). */
export interface CoordinateClickRecord {
  at: number;
  step: number;
  x: number;
  y: number;
  /** Tên element đã đăng ký (nếu click qua tên). */
  elementName?: string;
  /** URL trang lúc click. */
  url: string;
  button: 'left' | 'right' | 'middle';
}

export interface VisionFallbackOptions {
  /** Kích thước viewport mặc định (khi driver chưa báo). */
  viewport?: ViewportSize;
  /** Số element tối đa giữ trong registry (mặc định 200). */
  maxRegistry?: number;
  /** Số bản ghi click tối đa giữ (mặc định 200). */
  maxHistory?: number;
}

export class VisionFallback {
  private viewport: ViewportSize;
  private readonly maxRegistry: number;
  private readonly maxHistory: number;
  private registry = new Map<string, RegisteredVisualElement>();
  private history: CoordinateClickRecord[] = [];

  constructor(opts: VisionFallbackOptions = {}) {
    this.viewport = opts.viewport ?? { width: 1280, height: 720 };
    this.maxRegistry = opts.maxRegistry ?? 200;
    this.maxHistory = opts.maxHistory ?? 200;
  }

  /** Cập nhật viewport thực tế (driver báo sau khi mở page). */
  setViewport(viewport: ViewportSize): void {
    if (viewport.width <= 0 || viewport.height <= 0) {
      throw new Error(`Invalid viewport ${viewport.width}x${viewport.height}: dimensions must be positive.`);
    }
    this.viewport = { ...viewport };
  }

  getViewport(): ViewportSize {
    return { ...this.viewport };
  }

  /** true khi (x, y) nằm trong viewport. */
  isInViewport(x: number, y: number): boolean {
    return (
      Number.isFinite(x) &&
      Number.isFinite(y) &&
      x >= 0 &&
      y >= 0 &&
      x < this.viewport.width &&
      y < this.viewport.height
    );
  }

  /** Lý do tọa độ không hợp lệ (null khi hợp lệ). */
  validateCoordinates(x: number, y: number): string | null {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 'Coordinates must be finite numbers.';
    if (x < 0 || y < 0) return `Coordinates (${x}, ${y}) are negative.`;
    if (x >= this.viewport.width || y >= this.viewport.height) {
      return `Coordinates (${x}, ${y}) are outside the ${this.viewport.width}x${this.viewport.height} viewport.`;
    }
    return null;
  }

  // --- Registry: element không-role ---------------------------------------

  /** Đăng ký bbox của element không-role (ghi đè khi trùng tên). */
  registerElement(name: string, box: ElementBox, description?: string): RegisteredVisualElement {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('Visual element name must not be empty.');
    if (box.width <= 0 || box.height <= 0) {
      throw new Error(`Invalid box for "${trimmed}": width/height must be positive.`);
    }
    if (!this.registry.has(trimmed) && this.registry.size >= this.maxRegistry) {
      // Evict entry cũ nhất (Map giữ thứ tự insert).
      const oldest = this.registry.keys().next().value as string | undefined;
      if (oldest !== undefined) this.registry.delete(oldest);
    }
    const entry: RegisteredVisualElement = {
      name: trimmed,
      box: { ...box },
      description,
      registeredAt: Date.now(),
    };
    this.registry.set(trimmed, entry);
    return entry;
  }

  /** Xoá một element khỏi registry. */
  unregisterElement(name: string): boolean {
    return this.registry.delete(name.trim());
  }

  /** Lấy element theo tên (null khi chưa đăng ký). */
  getElement(name: string): RegisteredVisualElement | null {
    return this.registry.get(name.trim()) ?? null;
  }

  /** Tất cả element đã đăng ký (bản sao). */
  listElements(): RegisteredVisualElement[] {
    return [...this.registry.values()];
  }

  /** Tâm của box (điểm click mặc định cho element). */
  static centerOf(box: ElementBox): { x: number; y: number } {
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }

  /** Tâm của element đã đăng ký (null khi không có). */
  centerOfElement(name: string): { x: number; y: number } | null {
    const el = this.getElement(name);
    if (!el) return null;
    return VisionFallback.centerOf(el.box);
  }

  // --- Click ----------------------------------------------------------------

  /**
   * Click tại tọa độ (đã validate). `clicker` do driver thật cung cấp;
   * khi không có clicker (test) chỉ validate + ghi sổ.
   */
  async clickAt(
    x: number,
    y: number,
    opts: {
      step?: number;
      url?: string;
      button?: 'left' | 'right' | 'middle';
      clicker?: CoordinateClicker;
    } = {},
  ): Promise<CoordinateClickRecord> {
    const invalid = this.validateCoordinates(x, y);
    if (invalid) throw new Error(`Vision fallback click refused: ${invalid}`);
    const button = opts.button ?? 'left';
    if (opts.clicker) await opts.clicker(x, y, { button });
    const record: CoordinateClickRecord = {
      at: Date.now(),
      step: opts.step ?? 0,
      x,
      y,
      url: opts.url ?? '',
      button,
    };
    this.history.push(record);
    if (this.history.length > this.maxHistory) this.history.shift();
    return record;
  }

  /** Click element đã đăng ký bằng tên (tâm box). */
  async clickElement(
    name: string,
    opts: {
      step?: number;
      url?: string;
      button?: 'left' | 'right' | 'middle';
      clicker?: CoordinateClicker;
    } = {},
  ): Promise<CoordinateClickRecord> {
    const center = this.centerOfElement(name);
    if (!center) {
      throw new Error(
        `Vision fallback: no registered visual element named "${name}". ` +
          `Register it first (registerElement) or use browser_click_at with coordinates.`,
      );
    }
    const record = await this.clickAt(center.x, center.y, opts);
    record.elementName = name.trim();
    return record;
  }

  /** Lịch sử click tọa độ (mới nhất cuối). */
  get clickHistory(): CoordinateClickRecord[] {
    return [...this.history];
  }

  /** Số lần click qua vision fallback (dùng cho eval: tỉ lệ fallback). */
  get clickCount(): number {
    return this.history.length;
  }

  /** Xoá registry + lịch sử (vd khi đổi trang). */
  reset(): void {
    this.registry.clear();
    this.history = [];
  }
}

/** Tạo fallback với viewport mặc định của driver v2 (1280x720). */
export function createVisionFallback(opts: VisionFallbackOptions = {}): VisionFallback {
  return new VisionFallback(opts);
}
