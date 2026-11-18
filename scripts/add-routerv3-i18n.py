#!/usr/bin/env python3
"""Add routerV3.* i18n keys (v1.18 T3) to all 6 locales, keeping files sorted, 2-space indent, no trailing newline (repo format)."""
import json
from pathlib import Path

LOCALES_DIR = Path("apps/desktop/src/renderer/i18n/locales")

KEYS = {
    "vi": {
        "routerV3.title": "Router v3 — Model local",
        "routerV3.providersTitle": "Provider",
        "routerV3.providersCount": "{count} provider",
        "routerV3.policyCheapest": "Rẻ nhất",
        "routerV3.policyFastest": "Nhanh nhất",
        "routerV3.policyBalanced": "Cân bằng",
        "routerV3.localModels": "{count} model local",
        "routerV3.localNoModels": "Chưa thấy model local nào",
        "routerV3.localNotRunning": "Server local chưa chạy",
        "routerV3.localScan": "Quét server local",
        "routerV3.localScanning": "Đang quét server local…",
        "routerV3.costEstimate": "Chi phí ước tính: {cost} USD",
        "routerV3.costFree": "Miễn phí (local)",
        "routerV3.capabilityCheck": "Kiểm tra capability",
        "routerV3.capabilityMissing": "Thiếu: {missing}",
        "routerV3.suggestedAlternative": "Gợi ý thay thế: {model}",
        "routerV3.circuitOpen": "Circuit đang mở",
        "routerV3.circuitClosed": "Circuit đã đóng",
        "routerV3.latencyTitle": "Latency thực tế",
        "routerV3.rankTitle": "Xếp hạng provider",
        "routerV3.chatFailed": "Tất cả provider đều lỗi — xem hướng dẫn.",
        "routerV3.providerDisabled": "Provider đã tắt",
        "routerV3.noProvider": "Chưa có provider nào khả dụng",
        "routerV3.fallbackActive": "Đang dùng fallback: {provider}",
        "routerV3.estimatedPrice": "Giá ước lượng",
        "routerV3.retrying": "Đang thử lại ({attempt}/{max})…",
    },
    "en": {
        "routerV3.title": "Router v3 — Local models",
        "routerV3.providersTitle": "Providers",
        "routerV3.providersCount": "{count} providers",
        "routerV3.policyCheapest": "Cheapest",
        "routerV3.policyFastest": "Fastest",
        "routerV3.policyBalanced": "Balanced",
        "routerV3.localModels": "{count} local models",
        "routerV3.localNoModels": "No local models found",
        "routerV3.localNotRunning": "Local server is not running",
        "routerV3.localScan": "Scan local servers",
        "routerV3.localScanning": "Scanning local servers…",
        "routerV3.costEstimate": "Estimated cost: {cost} USD",
        "routerV3.costFree": "Free (local)",
        "routerV3.capabilityCheck": "Check capabilities",
        "routerV3.capabilityMissing": "Missing: {missing}",
        "routerV3.suggestedAlternative": "Suggested alternative: {model}",
        "routerV3.circuitOpen": "Circuit is open",
        "routerV3.circuitClosed": "Circuit is closed",
        "routerV3.latencyTitle": "Measured latency",
        "routerV3.rankTitle": "Provider ranking",
        "routerV3.chatFailed": "All providers failed — see the guidance.",
        "routerV3.providerDisabled": "Provider disabled",
        "routerV3.noProvider": "No provider available",
        "routerV3.fallbackActive": "Using fallback: {provider}",
        "routerV3.estimatedPrice": "Estimated price",
        "routerV3.retrying": "Retrying ({attempt}/{max})…",
    },
    "zh": {
        "routerV3.title": "路由器 v3 — 本地模型",
        "routerV3.providersTitle": "服务商",
        "routerV3.providersCount": "{count} 个服务商",
        "routerV3.policyCheapest": "最便宜",
        "routerV3.policyFastest": "最快",
        "routerV3.policyBalanced": "均衡",
        "routerV3.localModels": "{count} 个本地模型",
        "routerV3.localNoModels": "未发现本地模型",
        "routerV3.localNotRunning": "本地服务未运行",
        "routerV3.localScan": "扫描本地服务",
        "routerV3.localScanning": "正在扫描本地服务…",
        "routerV3.costEstimate": "预估费用：{cost} 美元",
        "routerV3.costFree": "免费（本地）",
        "routerV3.capabilityCheck": "检查能力",
        "routerV3.capabilityMissing": "缺少：{missing}",
        "routerV3.suggestedAlternative": "建议替代：{model}",
        "routerV3.circuitOpen": "熔断器已打开",
        "routerV3.circuitClosed": "熔断器已关闭",
        "routerV3.latencyTitle": "实测延迟",
        "routerV3.rankTitle": "服务商排名",
        "routerV3.chatFailed": "所有服务商均失败——请查看指引。",
        "routerV3.providerDisabled": "服务商已禁用",
        "routerV3.noProvider": "暂无可用服务商",
        "routerV3.fallbackActive": "正在使用备用：{provider}",
        "routerV3.estimatedPrice": "预估价格",
        "routerV3.retrying": "正在重试（{attempt}/{max}）…",
    },
    "ja": {
        "routerV3.title": "ルーター v3 — ローカルモデル",
        "routerV3.providersTitle": "プロバイダー",
        "routerV3.providersCount": "{count} 件のプロバイダー",
        "routerV3.policyCheapest": "最安",
        "routerV3.policyFastest": "最速",
        "routerV3.policyBalanced": "バランス",
        "routerV3.localModels": "ローカルモデル {count} 件",
        "routerV3.localNoModels": "ローカルモデルが見つかりません",
        "routerV3.localNotRunning": "ローカルサーバーが起動していません",
        "routerV3.localScan": "ローカルサーバーをスキャン",
        "routerV3.localScanning": "ローカルサーバーをスキャン中…",
        "routerV3.costEstimate": "推定コスト：{cost} USD",
        "routerV3.costFree": "無料（ローカル）",
        "routerV3.capabilityCheck": "機能を確認",
        "routerV3.capabilityMissing": "不足：{missing}",
        "routerV3.suggestedAlternative": "代替案：{model}",
        "routerV3.circuitOpen": "サーキットが開いています",
        "routerV3.circuitClosed": "サーキットが閉じています",
        "routerV3.latencyTitle": "実測レイテンシ",
        "routerV3.rankTitle": "プロバイダーの順位",
        "routerV3.chatFailed": "すべてのプロバイダーが失敗しました——案内を確認してください。",
        "routerV3.providerDisabled": "プロバイダーが無効です",
        "routerV3.noProvider": "利用可能なプロバイダーがありません",
        "routerV3.fallbackActive": "フォールバックを使用中：{provider}",
        "routerV3.estimatedPrice": "推定価格",
        "routerV3.retrying": "再試行中（{attempt}/{max}）…",
    },
    "es": {
        "routerV3.title": "Router v3 — Modelos locales",
        "routerV3.providersTitle": "Proveedores",
        "routerV3.providersCount": "{count} proveedores",
        "routerV3.policyCheapest": "Más barato",
        "routerV3.policyFastest": "Más rápido",
        "routerV3.policyBalanced": "Equilibrado",
        "routerV3.localModels": "{count} modelos locales",
        "routerV3.localNoModels": "No se encontraron modelos locales",
        "routerV3.localNotRunning": "El servidor local no está en ejecución",
        "routerV3.localScan": "Escanear servidores locales",
        "routerV3.localScanning": "Escaneando servidores locales…",
        "routerV3.costEstimate": "Costo estimado: {cost} USD",
        "routerV3.costFree": "Gratis (local)",
        "routerV3.capabilityCheck": "Comprobar capacidades",
        "routerV3.capabilityMissing": "Falta: {missing}",
        "routerV3.suggestedAlternative": "Alternativa sugerida: {model}",
        "routerV3.circuitOpen": "El circuito está abierto",
        "routerV3.circuitClosed": "El circuito está cerrado",
        "routerV3.latencyTitle": "Latencia medida",
        "routerV3.rankTitle": "Ranking de proveedores",
        "routerV3.chatFailed": "Todos los proveedores fallaron; consulta la guía.",
        "routerV3.providerDisabled": "Proveedor desactivado",
        "routerV3.noProvider": "No hay ningún proveedor disponible",
        "routerV3.fallbackActive": "Usando alternativa: {provider}",
        "routerV3.estimatedPrice": "Precio estimado",
        "routerV3.retrying": "Reintentando ({attempt}/{max})…",
    },
    "fr": {
        "routerV3.title": "Routeur v3 — Modèles locaux",
        "routerV3.providersTitle": "Fournisseurs",
        "routerV3.providersCount": "{count} fournisseurs",
        "routerV3.policyCheapest": "Le moins cher",
        "routerV3.policyFastest": "Le plus rapide",
        "routerV3.policyBalanced": "Équilibré",
        "routerV3.localModels": "{count} modèles locaux",
        "routerV3.localNoModels": "Aucun modèle local trouvé",
        "routerV3.localNotRunning": "Le serveur local n’est pas en cours d’exécution",
        "routerV3.localScan": "Analyser les serveurs locaux",
        "routerV3.localScanning": "Analyse des serveurs locaux…",
        "routerV3.costEstimate": "Coût estimé : {cost} USD",
        "routerV3.costFree": "Gratuit (local)",
        "routerV3.capabilityCheck": "Vérifier les capacités",
        "routerV3.capabilityMissing": "Manquant : {missing}",
        "routerV3.suggestedAlternative": "Alternative suggérée : {model}",
        "routerV3.circuitOpen": "Le disjoncteur est ouvert",
        "routerV3.circuitClosed": "Le disjoncteur est fermé",
        "routerV3.latencyTitle": "Latence mesurée",
        "routerV3.rankTitle": "Classement des fournisseurs",
        "routerV3.chatFailed": "Tous les fournisseurs ont échoué — voir les conseils.",
        "routerV3.providerDisabled": "Fournisseur désactivé",
        "routerV3.noProvider": "Aucun fournisseur disponible",
        "routerV3.fallbackActive": "Bascule utilisée : {provider}",
        "routerV3.estimatedPrice": "Prix estimé",
        "routerV3.retrying": "Nouvelle tentative ({attempt}/{max})…",
    },
}

for loc, new_keys in KEYS.items():
    path = LOCALES_DIR / f"{loc}.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    before = len(data)
    for key, value in new_keys.items():
        assert key not in data, f"{loc}: key already exists: {key}"
        data[key] = value
    ordered = dict(sorted(data.items()))
    path.write_text(json.dumps(ordered, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"{loc}: {before} -> {len(ordered)} (+{len(new_keys)})")

# Cross-check: same key set + same placeholders as en.
import re

def placeholders(text):
    return sorted(re.findall(r"\{(\w+)\}", text))

en_keys = set(KEYS["en"])
for loc in KEYS:
    assert set(KEYS[loc]) == en_keys, f"{loc}: key set differs"
    for key in en_keys:
        assert placeholders(KEYS[loc][key]) == placeholders(KEYS["en"][key]), (
            f"{loc}.{key}: placeholder mismatch: {KEYS[loc][key]!r} vs {KEYS['en'][key]!r}"
        )
print("OK: 26 keys x 6 locales, placeholders match en.")
