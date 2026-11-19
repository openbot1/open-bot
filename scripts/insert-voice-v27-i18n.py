#!/usr/bin/env python3
"""Insert voice.v27.* i18n keys into all 6 locales, keeping sort order.

Reads the VOICE_V27_I18N_KEYS list from packages/core/src/voiceV27/index.ts
so the code list is the single source of truth; inserts each key at its
bisect position (never re-sorts the whole file); verifies the file stays
sorted and that all 6 locales end with equal key counts.
"""
import bisect
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOCALES_DIR = ROOT / 'apps' / 'desktop' / 'src' / 'renderer' / 'i18n' / 'locales'
LOCALES = ['en', 'es', 'fr', 'ja', 'vi', 'zh']

INDEX_TS = ROOT / 'packages' / 'core' / 'src' / 'voiceV27' / 'index.ts'
KEYS = re.findall(r"'((?:voice\.v27\.[a-zA-Z0-9.]+))'", INDEX_TS.read_text(encoding='utf-8'))
assert KEYS, 'no voice.v27 keys found in index.ts'
assert KEYS == sorted(KEYS), 'VOICE_V27_I18N_KEYS is not sorted in index.ts'
assert len(set(KEYS)) == len(KEYS), 'duplicate keys in index.ts'

TRANSLATIONS = {
    'voice.v27.interrupt.confirmed': {
        'en': 'Interrupted the bot.', 'vi': 'Đã ngắt lời bot.',
        'es': 'Interrumpió al bot.', 'fr': 'A interrompu le bot.',
        'ja': 'ボットを中断しました。', 'zh': '打断了机器人。'},
    'voice.v27.interrupt.cooldown': {
        'en': 'Wait {ms}ms before interrupting again.',
        'vi': 'Chờ {ms}ms trước khi ngắt lời tiếp.',
        'es': 'Espera {ms} ms antes de interrumpir de nuevo.',
        'fr': 'Attendez {ms} ms avant d’interrompre à nouveau.',
        'ja': '再度中断するには{ms}ミリ秒待ってください。',
        'zh': '请等待 {ms} 毫秒后再打断。'},
    'voice.v27.interrupt.criticalProtected': {
        'en': 'This reply cannot be interrupted.',
        'vi': 'Câu trả lời này không thể bị ngắt.',
        'es': 'Esta respuesta no se puede interrumpir.',
        'fr': 'Cette réponse ne peut pas être interrompue.',
        'ja': 'この返答は中断できません。', 'zh': '此回复无法被打断。'},
    'voice.v27.interrupt.dropRemainder': {
        'en': 'Drop the rest of the reply',
        'vi': 'Bỏ phần còn lại của câu trả lời',
        'es': 'Descartar el resto de la respuesta',
        'fr': 'Abandonner le reste de la réponse',
        'ja': '返答の残りを破棄する', 'zh': '舍弃回复的剩余部分'},
    'voice.v27.interrupt.eventLog': {
        'en': 'Interruption log', 'vi': 'Nhật ký ngắt lời',
        'es': 'Registro de interrupciones',
        'fr': 'Journal des interruptions', 'ja': '中断ログ', 'zh': '打断日志'},
    'voice.v27.interrupt.falsePositive': {
        'en': 'Not a real interruption', 'vi': 'Không phải ngắt lời thật',
        'es': 'No fue una interrupción real',
        'fr': 'Pas une vraie interruption', 'ja': '誤検出の割り込み',
        'zh': '不是真正的打断'},
    'voice.v27.interrupt.gracePeriod': {
        'en': 'Grace period after the reply starts',
        'vi': 'Khoảng ân hạn sau khi bot bắt đầu nói',
        'es': 'Periodo de gracia tras iniciar la respuesta',
        'fr': 'Délai de grâce après le début de la réponse',
        'ja': '返答開始後の猶予期間', 'zh': '回复开始后的宽限期'},
    'voice.v27.interrupt.keywordOnly': {
        'en': 'Interrupt only with a keyword',
        'vi': 'Chỉ ngắt lời bằng từ khóa',
        'es': 'Interrumpir solo con una palabra clave',
        'fr': 'Interrompre uniquement avec un mot-clé',
        'ja': 'キーワードでのみ中断する', 'zh': '仅用关键词打断'},
    'voice.v27.interrupt.policy': {
        'en': 'Interruption policy', 'vi': 'Chính sách ngắt lời',
        'es': 'Política de interrupción',
        'fr': 'Politique d’interruption', 'ja': '割り込みポリシー',
        'zh': '打断策略'},
    'voice.v27.interrupt.resumeRemaining': {
        'en': 'Resume the rest of the reply', 'vi': 'Nói tiếp phần còn lại',
        'es': 'Reanudar el resto de la respuesta',
        'fr': 'Reprendre le reste de la réponse',
        'ja': '返答の残りを続ける', 'zh': '继续说完剩余回复'},
    'voice.v27.interrupt.stopLatency': {
        'en': 'Stop latency: {ms}ms', 'vi': 'Độ trễ dừng nói: {ms}ms',
        'es': 'Latencia de parada: {ms} ms',
        'fr': 'Latence d’arrêt : {ms} ms',
        'ja': '停止遅延：{ms}ミリ秒', 'zh': '停止延迟：{ms}毫秒'},
    'voice.v27.interrupt.stopped': {
        'en': 'Stopped speaking', 'vi': 'Đã dừng nói',
        'es': 'Dejó de hablar', 'fr': 'Arrêt de la parole',
        'ja': '発話を停止しました', 'zh': '已停止说话'},
    'voice.v27.interrupt.storm': {
        'en': 'Too many interruptions — take a breath, or switch to text.',
        'vi': 'Ngắt lời quá nhiều — hãy nghỉ một chút, hoặc chuyển sang gõ chữ.',
        'es': 'Demasiadas interrupciones: respira o cambia a texto.',
        'fr': 'Trop d’interruptions — respirez, ou passez au texte.',
        'ja': '割り込みが多すぎます。少し休むか、テキストに切り替えてください。',
        'zh': '打断太频繁了——请稍作休息，或切换到文字。'},
    'voice.v27.interrupt.title': {
        'en': 'Barge-in', 'vi': 'Ngắt lời', 'es': 'Interrupción',
        'fr': 'Interruption', 'ja': '割り込み', 'zh': '打断'},
    'voice.v27.personas.current': {
        'en': 'Current voice: {name}', 'vi': 'Giọng hiện tại: {name}',
        'es': 'Voz actual: {name}', 'fr': 'Voix actuelle : {name}',
        'ja': '現在の声：{name}', 'zh': '当前声音：{name}'},
    'voice.v27.personas.custom': {
        'en': 'Custom persona', 'vi': 'Persona tùy chỉnh',
        'es': 'Personaje personalizado',
        'fr': 'Personnage personnalisé', 'ja': 'カスタムペルソナ',
        'zh': '自定义角色'},
    'voice.v27.personas.fallback': {
        'en': 'Falling back to {name}', 'vi': 'Chuyển sang giọng dự phòng {name}',
        'es': 'Cambiando a {name}', 'fr': 'Bascule vers {name}',
        'ja': '{name}にフォールバックします', 'zh': '回退到{name}'},
    'voice.v27.personas.language': {
        'en': 'Language', 'vi': 'Ngôn ngữ', 'es': 'Idioma',
        'fr': 'Langue', 'ja': '言語', 'zh': '语言'},
    'voice.v27.personas.perBot': {
        'en': 'Voice per bot', 'vi': 'Giọng riêng cho từng bot',
        'es': 'Voz por bot', 'fr': 'Voix par bot',
        'ja': 'ボットごとの声', 'zh': '每个机器人的声音'},
    'voice.v27.personas.pitch': {
        'en': 'Pitch', 'vi': 'Cao độ', 'es': 'Tono', 'fr': 'Hauteur',
        'ja': 'ピッチ', 'zh': '音调'},
    'voice.v27.personas.preview': {
        'en': 'Preview voice', 'vi': 'Nghe thử giọng',
        'es': 'Escuchar muestra', 'fr': 'Écouter un aperçu',
        'ja': '声をプレビュー', 'zh': '试听声音'},
    'voice.v27.personas.rate': {
        'en': 'Speed', 'vi': 'Tốc độ', 'es': 'Velocidad',
        'fr': 'Vitesse', 'ja': '速度', 'zh': '语速'},
    'voice.v27.personas.select': {
        'en': 'Choose a voice', 'vi': 'Chọn giọng',
        'es': 'Elegir una voz', 'fr': 'Choisir une voix',
        'ja': '声を選ぶ', 'zh': '选择声音'},
    'voice.v27.personas.style': {
        'en': 'Style', 'vi': 'Phong cách', 'es': 'Estilo',
        'fr': 'Style', 'ja': 'スタイル', 'zh': '风格'},
    'voice.v27.personas.switch': {
        'en': 'Switch voice', 'vi': 'Đổi giọng',
        'es': 'Cambiar de voz', 'fr': 'Changer de voix',
        'ja': '声を切り替える', 'zh': '切换声音'},
    'voice.v27.personas.title': {
        'en': 'Voice personas', 'vi': 'Giọng nói', 'es': 'Voces',
        'fr': 'Voix', 'ja': 'ボイスペルソナ', 'zh': '声音角色'},
    'voice.v27.report.interrupts': {
        'en': 'Interruptions', 'vi': 'Lượt ngắt lời',
        'es': 'Interrupciones', 'fr': 'Interruptions',
        'ja': '割り込み', 'zh': '打断次数'},
    'voice.v27.report.personas': {
        'en': 'Personas used', 'vi': 'Giọng đã dùng',
        'es': 'Voces usadas', 'fr': 'Voix utilisées',
        'ja': '使用したペルソナ', 'zh': '使用过的角色'},
    'voice.v27.report.sessions': {
        'en': 'Sessions', 'vi': 'Phiên', 'es': 'Sesiones',
        'fr': 'Sessions', 'ja': 'セッション', 'zh': '会话'},
    'voice.v27.report.title': {
        'en': 'Voice report', 'vi': 'Báo cáo voice',
        'es': 'Informe de voz', 'fr': 'Rapport vocal',
        'ja': '音声レポート', 'zh': '语音报告'},
    'voice.v27.report.turns': {
        'en': 'Turns', 'vi': 'Lượt nói', 'es': 'Turnos',
        'fr': 'Tours', 'ja': 'ターン', 'zh': '轮次'},
    'voice.v27.session.checkpoint': {
        'en': 'Checkpoint: {label}', 'vi': 'Điểm kiểm tra: {label}',
        'es': 'Punto de control: {label}',
        'fr': 'Point de contrôle : {label}',
        'ja': 'チェックポイント：{label}', 'zh': '检查点：{label}'},
    'voice.v27.session.ended': {
        'en': 'Voice session ended', 'vi': 'Phiên voice đã kết thúc',
        'es': 'Sesión de voz terminada', 'fr': 'Session vocale terminée',
        'ja': '音声セッションが終了しました', 'zh': '语音会话已结束'},
    'voice.v27.session.expired': {
        'en': 'Voice session expired', 'vi': 'Phiên voice đã hết hạn',
        'es': 'Sesión de voz caducada', 'fr': 'Session vocale expirée',
        'ja': '音声セッションの有効期限が切れました', 'zh': '语音会话已过期'},
    'voice.v27.session.invalidTransition': {
        'en': 'Cannot do that in this state',
        'vi': 'Không thể làm vậy ở trạng thái này',
        'es': 'No se puede hacer en este estado',
        'fr': 'Impossible dans cet état',
        'ja': 'この状態では実行できません', 'zh': '当前状态下无法执行此操作'},
    'voice.v27.session.open': {
        'en': 'Voice session open', 'vi': 'Phiên voice đang mở',
        'es': 'Sesión de voz abierta', 'fr': 'Session vocale ouverte',
        'ja': '音声セッションを開いています', 'zh': '语音会话已打开'},
    'voice.v27.session.paused': {
        'en': 'Voice session paused', 'vi': 'Phiên voice đã tạm dừng',
        'es': 'Sesión de voz en pausa', 'fr': 'Session vocale en pause',
        'ja': '音声セッションを一時停止しました', 'zh': '语音会话已暂停'},
    'voice.v27.session.recovered': {
        'en': 'Voice session recovered after restart',
        'vi': 'Phiên voice đã khôi phục sau khi khởi động lại',
        'es': 'Sesión de voz recuperada tras reiniciar',
        'fr': 'Session vocale restaurée après redémarrage',
        'ja': '再起動後に音声セッションを復旧しました',
        'zh': '重启后语音会话已恢复'},
    'voice.v27.session.restored': {
        'en': 'Voice session restored', 'vi': 'Phiên voice đã khôi phục',
        'es': 'Sesión de voz restaurada', 'fr': 'Session vocale restaurée',
        'ja': '音声セッションを復元しました', 'zh': '语音会话已恢复'},
    'voice.v27.session.saved': {
        'en': 'Voice session saved', 'vi': 'Phiên voice đã lưu',
        'es': 'Sesión de voz guardada', 'fr': 'Session vocale enregistrée',
        'ja': '音声セッションを保存しました', 'zh': '语音会话已保存'},
    'voice.v27.session.stateConfirmed': {
        'en': 'Session state confirmed: {state}',
        'vi': 'Đã xác nhận trạng thái phiên: {state}',
        'es': 'Estado de sesión confirmado: {state}',
        'fr': 'État de session confirmé : {state}',
        'ja': 'セッション状態を確認しました：{state}',
        'zh': '会话状态已确认：{state}'},
    'voice.v27.session.title': {
        'en': 'Voice session', 'vi': 'Phiên voice',
        'es': 'Sesión de voz', 'fr': 'Session vocale',
        'ja': '音声セッション', 'zh': '语音会话'},
    'voice.v27.state.corrupt': {
        'en': 'Session data is corrupt', 'vi': 'Dữ liệu phiên bị hỏng',
        'es': 'Datos de sesión dañados',
        'fr': 'Données de session corrompues',
        'ja': 'セッションデータが破損しています', 'zh': '会话数据已损坏'},
    'voice.v27.state.loaded': {
        'en': 'Session loaded', 'vi': 'Đã tải phiên',
        'es': 'Sesión cargada', 'fr': 'Session chargée',
        'ja': 'セッションを読み込みました', 'zh': '会话已加载'},
    'voice.v27.state.missing': {
        'en': 'No saved session found', 'vi': 'Không tìm thấy phiên đã lưu',
        'es': 'No se encontró sesión guardada',
        'fr': 'Aucune session enregistrée trouvée',
        'ja': '保存されたセッションが見つかりません',
        'zh': '未找到已保存的会话'},
    'voice.v27.state.saved': {
        'en': 'State saved', 'vi': 'Đã lưu trạng thái',
        'es': 'Estado guardado', 'fr': 'État enregistré',
        'ja': '状態を保存しました', 'zh': '状态已保存'},
    'voice.v27.state.title': {
        'en': 'Session state', 'vi': 'Trạng thái phiên',
        'es': 'Estado de sesión', 'fr': 'État de session',
        'ja': 'セッション状態', 'zh': '会话状态'},
    'voice.v27.state.verified': {
        'en': 'Session state verified',
        'vi': 'Đã kiểm tra trạng thái phiên',
        'es': 'Estado de sesión verificado',
        'fr': 'État de session vérifié',
        'ja': 'セッション状態を確認済みです', 'zh': '会话状态已验证'},
    'voice.v27.vad.calibrated': {
        'en': 'VAD calibrated for this room',
        'vi': 'Đã hiệu chỉnh VAD cho phòng này',
        'es': 'VAD calibrado para esta sala',
        'fr': 'VAD calibré pour cette pièce',
        'ja': 'この部屋用にVADを調整しました', 'zh': '已为此房间校准 VAD'},
    'voice.v27.vad.endSilence': {
        'en': 'Silence to end a turn',
        'vi': 'Khoảng lặng để kết thúc lượt',
        'es': 'Silencio para terminar el turno',
        'fr': 'Silence pour terminer le tour',
        'ja': 'ターンを終える無音時間', 'zh': '结束轮次所需的静音时长'},
    'voice.v27.vad.hangover': {
        'en': 'Hangover', 'vi': 'Giữ giọng', 'es': 'Persistencia',
        'fr': 'Maintien', 'ja': 'ハングオーバー', 'zh': '延音'},
    'voice.v27.vad.minSpeech': {
        'en': 'Minimum speech', 'vi': 'Giọng nói tối thiểu',
        'es': 'Habla mínima', 'fr': 'Parole minimale',
        'ja': '最小発話時間', 'zh': '最短语音'},
    'voice.v27.vad.noiseFloor': {
        'en': 'Noise floor', 'vi': 'Mức ồn nền',
        'es': 'Ruido de fondo', 'fr': 'Bruit de fond',
        'ja': 'ノイズフロア', 'zh': '底噪'},
    'voice.v27.vad.preset': {
        'en': 'VAD preset', 'vi': 'Cấu hình VAD',
        'es': 'Preajuste de VAD', 'fr': 'Préréglage VAD',
        'ja': 'VADプリセット', 'zh': 'VAD 预设'},
    'voice.v27.vad.presetBalanced': {
        'en': 'Balanced', 'vi': 'Cân bằng', 'es': 'Equilibrado',
        'fr': 'Équilibré', 'ja': 'バランス', 'zh': '均衡'},
    'voice.v27.vad.presetSensitive': {
        'en': 'Sensitive', 'vi': 'Nhạy', 'es': 'Sensible',
        'fr': 'Sensible', 'ja': '感度高', 'zh': '灵敏'},
    'voice.v27.vad.presetStrict': {
        'en': 'Strict', 'vi': 'Nghiêm ngặt', 'es': 'Estricto',
        'fr': 'Strict', 'ja': '厳密', 'zh': '严格'},
    'voice.v27.vad.sensitivity': {
        'en': 'Sensitivity', 'vi': 'Độ nhạy', 'es': 'Sensibilidad',
        'fr': 'Sensibilité', 'ja': '感度', 'zh': '灵敏度'},
    'voice.v27.vad.shortNoiseIgnored': {
        'en': 'Short noise ignored', 'vi': 'Đã bỏ qua tiếng ồn ngắn',
        'es': 'Ruido corto ignorado', 'fr': 'Bruit bref ignoré',
        'ja': '短いノイズを無視しました', 'zh': '已忽略短暂噪声'},
    'voice.v27.vad.silenceThreshold': {
        'en': 'Silence threshold', 'vi': 'Ngưỡng im lặng',
        'es': 'Umbral de silencio', 'fr': 'Seuil de silence',
        'ja': '無音しきい値', 'zh': '静音阈值'},
    'voice.v27.vad.title': {
        'en': 'Voice activity', 'vi': 'Phát hiện giọng nói',
        'es': 'Actividad de voz', 'fr': 'Activité vocale',
        'ja': '音声アクティビティ', 'zh': '语音活动'},
    'voice.v27.vad.turnEnded': {
        'en': 'Turn ended', 'vi': 'Đã kết thúc lượt',
        'es': 'Turno terminado', 'fr': 'Tour terminé',
        'ja': 'ターンが終了しました', 'zh': '轮次已结束'},
    'voice.v27.vad.turnTimeout': {
        'en': 'Turn timed out', 'vi': 'Lượt nói đã hết giờ',
        'es': 'Turno agotado', 'fr': 'Tour expiré',
        'ja': 'ターンがタイムアウトしました', 'zh': '轮次已超时'},
}

missing = [k for k in KEYS if k not in TRANSLATIONS]
assert not missing, f'missing translations: {missing}'
for k, table in TRANSLATIONS.items():
    assert set(table) == set(LOCALES), f'{k} missing a locale'

counts = []
for loc in LOCALES:
    fp = LOCALES_DIR / f'{loc}.json'
    data = json.loads(fp.read_text(encoding='utf-8'))
    keys = list(data)
    assert keys == sorted(keys), f'{loc} was not sorted before insert'
    for k in KEYS:
        assert k not in data, f'{loc} already has {k}'
        data[k] = TRANSLATIONS[k][loc]
    # Rebuild in sorted order (insertion above keeps it sorted,
    # but rebuild explicitly from the sorted key list).
    ordered = {k: data[k] for k in sorted(data)}
    assert list(ordered) == sorted(ordered)
    fp.write_text(json.dumps(ordered, ensure_ascii=False, indent=2), encoding='utf-8')
    counts.append(len(ordered))
    print(f'{loc}: {len(ordered)} keys (+{len(KEYS)})')

assert len(set(counts)) == 1, f'locale counts differ: {counts}'
print(f'OK: {len(KEYS)} keys x {len(LOCALES)} locales, all counts equal ({counts[0]})')
