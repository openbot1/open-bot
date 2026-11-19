#!/usr/bin/env python3
"""Insert fleet.v30.* i18n keys (v1.44, Team T6) after the fleet.v29.* block
in all 6 locale files. Textual insertion only — the rest of each file is
left byte-identical. Keys are sorted (fleet.v30.* sorts after fleet.v29.*).
"""
import json
import sys

KEYS = {
    # isolation
    "fleet.v30.isolationTitle": ("Per-conversation isolation", "Cách ly theo conversation", "按对话隔离", "会話ごとの分離", "Isolation par conversation", "Aislamiento por conversación"),
    "fleet.v30.isolationSubtitle": ("One isolated runtime per conversation, cleaned up when it ends.", "Mỗi conversation chạy trong một runtime riêng, dọn dẹp khi kết thúc.", "每个对话一个隔离运行时，结束时清理。", "会話ごとに分離されたランタイムを用意し、終了時にクリーンアップします。", "Un runtime isolé par conversation, nettoyé à la fin.", "Un runtime aislado por conversación, limpiado al terminar."),
    "fleet.v30.bind": ("Bind", "Gắn", "绑定", "バインド", "Lier", "Vincular"),
    "fleet.v30.binding": ("Binding", "Liên kết", "绑定", "バインド", "Liaison", "Vinculación"),
    "fleet.v30.bindings": ("Bindings", "Liên kết", "绑定", "バインド", "Liaisons", "Vinculaciones"),
    "fleet.v30.driver": ("Driver", "Driver", "驱动", "ドライバー", "Pilote", "Controlador"),
    "fleet.v30.drivers": ("Drivers", "Driver", "驱动", "ドライバー", "Pilotes", "Controladores"),
    "fleet.v30.workspace": ("Workspace", "Workspace", "工作区", "ワークスペース", "Espace de travail", "Espacio de trabajo"),
    "fleet.v30.networkMode": ("Network mode", "Chế độ mạng", "网络模式", "ネットワークモード", "Mode réseau", "Modo de red"),
    "fleet.v30.networkNone": ("No network", "Không mạng", "无网络", "ネットワークなし", "Aucun réseau", "Sin red"),
    "fleet.v30.networkLoopback": ("Loopback only", "Chỉ loopback", "仅回环", "ループバックのみ", "Boucle locale uniquement", "Solo loopback"),
    "fleet.v30.networkHost": ("Host network", "Mạng host", "主机网络", "ホストネットワーク", "Réseau hôte", "Red del host"),
    "fleet.v30.active": ("Active", "Đang chạy", "运行中", "アクティブ", "Actif", "Activo"),
    "fleet.v30.suspended": ("Suspended", "Tạm dừng", "已暂停", "一時停止", "Suspendu", "Suspendido"),
    "fleet.v30.cleaned": ("Cleaned", "Đã dọn", "已清理", "クリーンアップ済み", "Nettoyé", "Limpiado"),
    "fleet.v30.unisolated": ("Unisolated", "Không cách ly", "未隔离", "分離なし", "Non isolé", "Sin aislar"),
    "fleet.v30.unisolatedWarning": ("Runs WITHOUT isolation (local driver).", "Chạy KHÔNG có cách ly (driver local).", "未隔离运行（本地驱动）。", "分離なしで実行中（ローカルドライバー）。", "S’exécute SANS isolation (pilote local).", "Se ejecuta SIN aislamiento (controlador local)."),
    "fleet.v30.suspend": ("Suspend", "Tạm dừng", "暂停", "一時停止", "Suspendre", "Suspender"),
    "fleet.v30.resume": ("Resume", "Tiếp tục", "恢复", "再開", "Reprendre", "Reanudar"),
    "fleet.v30.endConversation": ("End conversation", "Kết thúc conversation", "结束对话", "会話を終了", "Terminer la conversation", "Terminar conversación"),
    "fleet.v30.cleanup": ("Cleanup", "Dọn dẹp", "清理", "クリーンアップ", "Nettoyage", "Limpieza"),
    "fleet.v30.wipedPaths": ("Wiped paths", "Đường dẫn đã xóa", "已清除路径", "消去されたパス", "Chemins effacés", "Rutas eliminadas"),
    "fleet.v30.orphaned": ("Orphaned", "Mồ côi", "孤立", "孤立", "Orphelin", "Huérfano"),
    "fleet.v30.usage": ("Usage", "Sử dụng", "使用量", "使用量", "Utilisation", "Uso"),
    "fleet.v30.cpu": ("CPU", "CPU", "CPU", "CPU", "CPU", "CPU"),
    "fleet.v30.ram": ("RAM", "RAM", "内存", "RAM", "RAM", "RAM"),
    "fleet.v30.disk": ("Disk", "Ổ đĩa", "磁盘", "ディスク", "Disque", "Disco"),
    "fleet.v30.bindSuccess": ("Conversation bound to an isolated runtime.", "Đã gắn conversation vào runtime cách ly.", "对话已绑定到隔离运行时。", "会話を分離ランタイムにバインドしました。", "Conversation liée à un runtime isolé.", "Conversación vinculada a un runtime aislado."),
    "fleet.v30.bindFailed": ("Could not bind the conversation.", "Không gắn được conversation.", "无法绑定对话。", "会話をバインドできませんでした。", "Impossible de lier la conversation.", "No se pudo vincular la conversación."),
    "fleet.v30.noDriver": ("No isolation driver is available on this host.", "Không có driver cách ly nào trên máy này.", "此主机上没有可用的隔离驱动。", "このホストで利用できる分離ドライバーがありません。", "Aucun pilote d’isolation disponible sur cet hôte.", "No hay ningún controlador de aislamiento disponible en este host."),
    "fleet.v30.localFallbackWarning": ("No sandbox available — running locally without isolation.", "Không có sandbox — chạy local, không cách ly.", "无沙箱可用——本地运行，未隔离。", "サンドボックスがありません——分離なしでローカル実行します。", "Aucun bac à sable — exécution locale sans isolation.", "Sin sandbox disponible: ejecución local sin aislamiento."),
    # board v2
    "fleet.v30.boardTitle": ("A2A task board v2", "Bảng task A2A v2", "A2A 任务板 v2", "A2A タスクボード v2", "Tableau de tâches A2A v2", "Tablero de tareas A2A v2"),
    "fleet.v30.boardSubtitle": ("Views, assignment, dependencies, deadlines and retries.", "View, giao việc, phụ thuộc, hạn chót và thử lại.", "视图、分配、依赖、截止日期与重试。", "ビュー、割り当て、依存関係、期限と再試行。", "Vues, affectation, dépendances, échéances et reprises.", "Vistas, asignación, dependencias, plazos y reintentos."),
    "fleet.v30.savedViews": ("Saved views", "View đã lưu", "已保存视图", "保存済みビュー", "Vues enregistrées", "Vistas guardadas"),
    "fleet.v30.createView": ("Create view", "Tạo view", "创建视图", "ビューを作成", "Créer une vue", "Crear vista"),
    "fleet.v30.applyView": ("Apply view", "Áp dụng view", "应用视图", "ビューを適用", "Appliquer la vue", "Aplicar vista"),
    "fleet.v30.deleteView": ("Delete view", "Xóa view", "删除视图", "ビューを削除", "Supprimer la vue", "Eliminar vista"),
    "fleet.v30.priority": ("Priority", "Ưu tiên", "优先级", "優先度", "Priorité", "Prioridad"),
    "fleet.v30.priorityLow": ("Low", "Thấp", "低", "低", "Basse", "Baja"),
    "fleet.v30.priorityNormal": ("Normal", "Bình thường", "普通", "通常", "Normale", "Normal"),
    "fleet.v30.priorityHigh": ("High", "Cao", "高", "高", "Haute", "Alta"),
    "fleet.v30.priorityUrgent": ("Urgent", "Khẩn", "紧急", "緊急", "Urgente", "Urgente"),
    "fleet.v30.deadline": ("Deadline", "Hạn chót", "截止日期", "期限", "Échéance", "Plazo"),
    "fleet.v30.sla": ("SLA", "SLA", "SLA", "SLA", "SLA", "SLA"),
    "fleet.v30.overdue": ("Overdue", "Quá hạn", "已逾期", "期限切れ", "En retard", "Atrasado"),
    "fleet.v30.escalated": ("Escalated", "Đã leo thang", "已升级", "エスカレーション済み", "Escaladé", "Escalado"),
    "fleet.v30.ready": ("Ready", "Sẵn sàng", "就绪", "準備完了", "Prêt", "Listo"),
    "fleet.v30.blocked": ("Blocked", "Bị chặn", "被阻塞", "ブロック中", "Bloqué", "Bloqueado"),
    "fleet.v30.dependencies": ("Dependencies", "Phụ thuộc", "依赖", "依存関係", "Dépendances", "Dependencias"),
    "fleet.v30.reassign": ("Reassign", "Giao lại", "重新分配", "再割り当て", "Réaffecter", "Reasignar"),
    "fleet.v30.retry": ("Retry", "Thử lại", "重试", "再試行", "Réessayer", "Reintentar"),
    "fleet.v30.retries": ("Retries", "Lần thử lại", "重试次数", "再試行回数", "Reprises", "Reintentos"),
    "fleet.v30.kanban": ("Kanban", "Kanban", "看板", "カンバン", "Kanban", "Kanban"),
    "fleet.v30.bulkCancel": ("Bulk cancel", "Hủy hàng loạt", "批量取消", "一括キャンセル", "Annulation groupée", "Cancelación masiva"),
    "fleet.v30.bulkReassign": ("Bulk reassign", "Giao lại hàng loạt", "批量重新分配", "一括再割り当て", "Réaffectation groupée", "Reasignación masiva"),
    "fleet.v30.timeline": ("Timeline", "Dòng thời gian", "时间线", "タイムライン", "Chronologie", "Cronología"),
    "fleet.v30.assignmentHistory": ("Assignment history", "Lịch sử giao việc", "分配历史", "割り当て履歴", "Historique des affectations", "Historial de asignación"),
    # peer groups
    "fleet.v30.groupsTitle": ("Peer groups", "Nhóm peer", "对等组", "ピアグループ", "Groupes de pairs", "Grupos de pares"),
    "fleet.v30.groupsSubtitle": ("Organise peers into groups and route tasks by capability.", "Xếp peer thành nhóm và định tuyến task theo năng lực.", "将对等方分组，并按能力路由任务。", "ピアをグループ化し、能力でタスクを振り分けます。", "Organisez les pairs en groupes et routez les tâches par capacité.", "Organiza pares en grupos y enruta tareas por capacidad."),
    "fleet.v30.createGroup": ("Create group", "Tạo nhóm", "创建组", "グループを作成", "Créer un groupe", "Crear grupo"),
    "fleet.v30.groupName": ("Group name", "Tên nhóm", "组名", "グループ名", "Nom du groupe", "Nombre del grupo"),
    "fleet.v30.members": ("Members", "Thành viên", "成员", "メンバー", "Membres", "Miembros"),
    "fleet.v30.ungrouped": ("Ungrouped", "Chưa vào nhóm", "未分组", "未分類", "Non groupés", "Sin grupo"),
    "fleet.v30.score": ("Score", "Điểm", "分数", "スコア", "Score", "Puntuación"),
    "fleet.v30.pickPeer": ("Pick best peer", "Chọn peer tốt nhất", "选择最佳对等方", "最適なピアを選択", "Choisir le meilleur pair", "Elegir el mejor par"),
    "fleet.v30.failover": ("Failover", "Chuyển dự phòng", "故障转移", "フェイルオーバー", "Bascule", "Conmutación"),
    "fleet.v30.probe": ("Probe", "Thăm dò", "探测", "プローブ", "Sonde", "Sondeo"),
    "fleet.v30.reachable": ("Reachable", "Truy cập được", "可达", "到達可能", "Joignable", "Accesible"),
    "fleet.v30.latency": ("Latency", "Độ trễ", "延迟", "レイテンシ", "Latence", "Latencia"),
    # admin policy
    "fleet.v30.adminTitle": ("Allowlist admin v2", "Quản trị allowlist v2", "允许名单管理 v2", "許可リスト管理 v2", "Admin de la liste d’autorisation v2", "Admin de lista de permitidos v2"),
    "fleet.v30.adminSubtitle": ("Roles, policy rules, approvals and the pre-flight check.", "Vai trò, quy tắc, phê duyệt và kiểm tra pre-flight.", "角色、策略规则、审批与预检。", "役割、ポリシールール、承認と事前チェック。", "Rôles, règles, approbations et vérification préalable.", "Roles, reglas, aprobaciones y verificación previa."),
    "fleet.v30.admins": ("Admins", "Quản trị viên", "管理员", "管理者", "Admins", "Administradores"),
    "fleet.v30.roles": ("Roles", "Vai trò", "角色", "役割", "Rôles", "Roles"),
    "fleet.v30.roleViewer": ("Viewer", "Người xem", "查看者", "閲覧者", "Lecteur", "Visor"),
    "fleet.v30.roleOperator": ("Operator", "Vận hành", "操作员", "オペレーター", "Opérateur", "Operador"),
    "fleet.v30.roleAdmin": ("Admin", "Quản trị viên", "管理员", "管理者", "Admin", "Admin"),
    "fleet.v30.policyRules": ("Policy rules", "Quy tắc chính sách", "策略规则", "ポリシールール", "Règles de politique", "Reglas de política"),
    "fleet.v30.createRule": ("Create rule", "Tạo quy tắc", "创建规则", "ルールを作成", "Créer une règle", "Crear regla"),
    "fleet.v30.timeWindow": ("Time window", "Khung giờ", "时间窗口", "時間枠", "Fenêtre horaire", "Ventana horaria"),
    "fleet.v30.maxCost": ("Max cost per task", "Chi phí tối đa / task", "每任务最高费用", "タスクあたりの最大コスト", "Coût max par tâche", "Costo máx. por tarea"),
    "fleet.v30.maxConcurrent": ("Max concurrent tasks", "Task đồng thời tối đa", "最大并发任务数", "最大同時タスク数", "Tâches simultanées max", "Tareas simultáneas máx."),
    "fleet.v30.requiresApproval": ("Requires approval", "Cần phê duyệt", "需要审批", "承認が必要", "Approbation requise", "Requiere aprobación"),
    "fleet.v30.approvalRequest": ("Approval request", "Yêu cầu phê duyệt", "审批请求", "承認リクエスト", "Demande d’approbation", "Solicitud de aprobación"),
    "fleet.v30.approve": ("Approve", "Phê duyệt", "批准", "承認", "Approuver", "Aprobar"),
    "fleet.v30.deny": ("Deny", "Từ chối", "拒绝", "拒否", "Refuser", "Denegar"),
    "fleet.v30.pending": ("Pending", "Đang chờ", "待处理", "保留中", "En attente", "Pendiente"),
    "fleet.v30.preflight": ("Pre-flight check", "Kiểm tra pre-flight", "预检", "事前チェック", "Vérification préalable", "Verificación previa"),
    "fleet.v30.preflightAllowed": ("Pre-flight passed — execution allowed.", "Pre-flight đạt — được phép thực thi.", "预检通过——允许执行。", "事前チェック合格——実行可能です。", "Vérification réussie — exécution autorisée.", "Verificación superada: ejecución permitida."),
    "fleet.v30.preflightDenied": ("Pre-flight denied — execution blocked.", "Pre-flight bị từ chối — thực thi bị chặn.", "预检被拒绝——执行已阻止。", "事前チェックが拒否されました——実行はブロックされました。", "Vérification refusée — exécution bloquée.", "Verificación denegada: ejecución bloqueada."),
    "fleet.v30.events": ("Events", "Sự kiện", "事件", "イベント", "Événements", "Eventos"),
}

LOCALES = ["en", "vi", "zh", "ja", "fr", "es"]
IDX = {"en": 0, "vi": 1, "zh": 2, "ja": 3, "fr": 4, "es": 5}

def main() -> int:
    for loc in LOCALES:
        path = f"apps/desktop/src/renderer/i18n/locales/{loc}.json"
        lines = open(path, encoding="utf-8").read().split("\n")
        # last fleet.v29.* line
        last = max(i for i, l in enumerate(lines) if l.startswith('  "fleet.v29.'))
        assert lines[last].rstrip().endswith(","), lines[last]
        block = []
        for key in sorted(KEYS):
            val = KEYS[key][IDX[loc]]
            block.append(f'  "{key}": {json.dumps(val, ensure_ascii=False)},')
        # last key in block must NOT end with a comma? It follows the v29
        # block, and the next line after insertion is the old line after
        # v29 (a key that sorts after fleet.v30.*), so the block's last
        # line DOES need its trailing comma.
        lines[last + 1:last + 1] = block
        open(path, "w", encoding="utf-8").write("\n".join(lines))
        print(loc, "inserted", len(block), "keys after line", last + 1)
    return 0

if __name__ == "__main__":
    sys.exit(main())
