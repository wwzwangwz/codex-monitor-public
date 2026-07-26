package com.codexmonitor.mobile

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.Image
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Undo
import androidx.compose.material.icons.outlined.Computer
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.LinkOff
import androidx.compose.material.icons.outlined.KeyboardArrowDown
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material.icons.outlined.HealthAndSafety
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.RestartAlt
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.material.icons.outlined.SystemUpdate
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Divider
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.app.NotificationManagerCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID
import java.io.File
import android.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private val Green = Color(0xFF24A065)
private val Red = Color(0xFFD84A4A)
private val Blue = Color(0xFF3184D8)
private val Black = Color(0xFF232725)
private val Ink = Color(0xFF18201D)
private val Muted = Color(0xFF68726E)
private val Canvas = Color(0xFFF5F7F6)
private enum class UpdatePhase { IDLE, CHECKING, AVAILABLE, DOWNLOADING }
private data class SessionTarget(val pairing: PairingData, val session: SessionStatus)

class MainActivity : ComponentActivity() {
    private var lastAutomaticUpdateCheckAt = 0L
    private var updatePhase by mutableStateOf(UpdatePhase.IDLE)
    private var updateOffer by mutableStateOf<UpdateOffer?>(null)
    private var pendingInstall: File? = null
    private var backgroundProtected by mutableStateOf(false)
    private var exactAlarmsAllowed by mutableStateOf(true)
    private var notificationsAllowed by mutableStateOf(true)
    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) {
        notificationsAllowed = NotificationManagerCompat.from(this).areNotificationsEnabled()
    }
    private val scanner = registerForActivityResult(ScanContract()) { result ->
        val value = result.contents ?: return@registerForActivityResult
        val incoming = runCatching { PairingCodec.parse(value) }.getOrNull()
        val previous = incoming?.let { MonitorStore.pairing(it.id) }
        val pairing = runCatching { MonitorStore.pairFromQr(value) }
            .onFailure { Toast.makeText(this, it.message ?: "配对失败", Toast.LENGTH_LONG).show() }
            .getOrNull() ?: return@registerForActivityResult
        if (previous?.relayWsUrl != null && previous.relayWsUrl != pairing.relayWsUrl) {
            PushRegistrationManager.unregister(this, previous)
        }
        if (MonitorStore.monitoringEnabled.value) {
            ContextCompat.startForegroundService(this, Intent(this, ConnectionService::class.java).apply {
                action = ConnectionService.ACTION_CONNECT
                putExtra(ConnectionService.EXTRA_DEVICE_ID, pairing.id)
            })
            Toast.makeText(
                this,
                if (previous == null) "已添加 ${pairing.name}，正在连接" else "已更新 ${pairing.name} 的连接并重新连接",
                Toast.LENGTH_SHORT,
            ).show()
        } else {
            Toast.makeText(this, "已保存 ${pairing.name}；请打开监控总开关后连接", Toast.LENGTH_LONG).show()
        }
        PushRegistrationManager.registerAll(this)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        MonitorStore.initialize(this)
        requestNotificationPermission()
        if (MonitorStore.monitoringEnabled.value) startMonitorService()
        setContent {
            CodexTheme {
                MonitorScreen(
                    onScan = ::scan,
                    onDisconnect = ::disconnect,
                    onConnectionPreferenceChange = ::setConnectionPreference,
                    onMonitoringChange = ::setMonitoringEnabled,
                    backgroundProtected = backgroundProtected,
                    exactAlarmsAllowed = exactAlarmsAllowed,
                    notificationsAllowed = notificationsAllowed,
                    onNotificationSettings = { BackgroundProtection.openNotificationSettings(this) },
                    onBatterySettings = { BackgroundProtection.openBatteryExemption(this) },
                    onExactAlarmSettings = { BackgroundProtection.openExactAlarmSettings(this) },
                    onAutoStartSettings = { BackgroundProtection.openAutoStartSettings(this) },
                    updatePhase = updatePhase,
                    updateOffer = updateOffer,
                    onCheckUpdate = { checkForUpdates(showLatestMessage = true) },
                    onInstallUpdate = ::downloadUpdate,
                    onDismissUpdate = { updatePhase = UpdatePhase.IDLE },
                    onSendGuidance = ::sendGuidance,
                    onGoalCommand = ::sendGoalCommand,
                )
            }
        }
        checkForUpdates(showLatestMessage = false)
        if (MonitorStore.monitoringEnabled.value) {
            window.decorView.postDelayed(::requestBackgroundExemption, 1_500L)
        }
    }

    override fun onStart() {
        super.onStart()
        sendVisibility(ConnectionService.ACTION_APP_FOREGROUND)
        val now = System.currentTimeMillis()
        if (UpdateCheckPolicy.shouldCheck(lastAutomaticUpdateCheckAt, now)) {
            checkForUpdates(showLatestMessage = false)
        }
    }

    override fun onStop() {
        sendVisibility(ConnectionService.ACTION_APP_BACKGROUND)
        super.onStop()
    }

    override fun onResume() {
        super.onResume()
        backgroundProtected = isBackgroundProtected()
        exactAlarmsAllowed = BackgroundProtection.exactAlarmsAllowed(this)
        notificationsAllowed = NotificationManagerCompat.from(this).areNotificationsEnabled()
        if (MonitorStore.monitoringEnabled.value) startMonitorService()
        val file = pendingInstall ?: return
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || packageManager.canRequestPackageInstalls()) {
            pendingInstall = null
            launchInstaller(file)
        }
    }

    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    private fun scan() {
        scanner.launch(
            ScanOptions()
                .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                .setPrompt("扫描电脑端 Codex Monitor 二维码")
                .setBeepEnabled(false)
                .setOrientationLocked(false),
        )
    }

    private fun startMonitorService() {
        ContextCompat.startForegroundService(this, Intent(this, ConnectionService::class.java))
    }

    private fun sendVisibility(actionValue: String) {
        if (!MonitorStore.monitoringEnabled.value) return
        ContextCompat.startForegroundService(this, Intent(this, ConnectionService::class.java).apply {
            action = actionValue
        })
    }

    private fun setMonitoringEnabled(enabled: Boolean) {
        if (!enabled) PushRegistrationManager.registerAll(this, enabled = false)
        MonitorStore.setMonitoringEnabled(enabled)
        val intent = Intent(this, ConnectionService::class.java).apply {
            action = ConnectionService.ACTION_SET_MONITORING
            putExtra(ConnectionService.EXTRA_MONITORING_ENABLED, enabled)
        }
        if (enabled) {
            PushRegistrationManager.registerAll(this, enabled = true)
            ContextCompat.startForegroundService(this, intent)
            window.decorView.postDelayed(::requestBackgroundExemption, 500L)
        } else {
            startService(intent)
        }
    }

    private fun requestBackgroundExemption() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
        val powerManager = getSystemService(PowerManager::class.java)
        if (powerManager.isIgnoringBatteryOptimizations(packageName)) return
        val preferences = getSharedPreferences("codex_monitor", MODE_PRIVATE)
        if (preferences.getBoolean("background_exemption_prompted", false)) return
        preferences.edit().putBoolean("background_exemption_prompted", true).apply()
        runCatching {
            startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                data = Uri.parse("package:$packageName")
            })
        }.onFailure {
            startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        }
    }

    private fun isBackgroundProtected(): Boolean = Build.VERSION.SDK_INT < Build.VERSION_CODES.M ||
        getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(packageName)

    private fun disconnect(id: String) {
        MonitorStore.pairings().firstOrNull { it.id == id }?.let { PushRegistrationManager.unregister(this, it) }
        if (!MonitorStore.monitoringEnabled.value) {
            MonitorStore.remove(id)
            return
        }
        startService(Intent(this, ConnectionService::class.java).apply {
            action = ConnectionService.ACTION_DISCONNECT
            putExtra(ConnectionService.EXTRA_DEVICE_ID, id)
        })
    }

    private fun setConnectionPreference(deviceId: String, preference: ConnectionPreference) {
        MonitorStore.setConnectionPreference(deviceId, preference)
        if (!MonitorStore.monitoringEnabled.value) return
        startService(Intent(this, ConnectionService::class.java).apply {
            action = ConnectionService.ACTION_SET_CONNECTION_PREFERENCE
            putExtra(ConnectionService.EXTRA_DEVICE_ID, deviceId)
            putExtra(ConnectionService.EXTRA_CONNECTION_PREFERENCE, preference.name)
        })
    }

    private fun sendGuidance(
        deviceId: String,
        sessionId: String,
        text: String,
        mode: String,
        attachments: List<GuidanceAttachment>,
    ) {
        if (!MonitorStore.monitoringEnabled.value) {
            MonitorStore.setGuidanceStatus(deviceId, sessionId, GuidanceUi(false, false, "监控已关闭，请先打开总开关"))
            return
        }
        val requestId = UUID.randomUUID().toString()
        MonitorStore.queueGuidance(GuidanceMessage(
            requestId = requestId,
            sessionId = sessionId,
            text = text.trim(),
            mode = mode,
            attachments = attachments,
        ))
        startService(Intent(this, ConnectionService::class.java).apply {
            action = ConnectionService.ACTION_SEND_GUIDANCE
            putExtra(ConnectionService.EXTRA_DEVICE_ID, deviceId)
            putExtra(ConnectionService.EXTRA_SESSION_ID, sessionId)
            putExtra(ConnectionService.EXTRA_REQUEST_ID, requestId)
        })
    }

    private fun sendGoalCommand(deviceId: String, sessionId: String, command: String, confirmed: Boolean) {
        if (!MonitorStore.monitoringEnabled.value) {
            MonitorStore.setGoalCommandStatus(deviceId, sessionId, GoalCommandUi(false, false, "监控已关闭，请先打开总开关"))
            return
        }
        startService(Intent(this, ConnectionService::class.java).apply {
            action = ConnectionService.ACTION_SEND_GOAL_COMMAND
            putExtra(ConnectionService.EXTRA_DEVICE_ID, deviceId)
            putExtra(ConnectionService.EXTRA_SESSION_ID, sessionId)
            putExtra(ConnectionService.EXTRA_GOAL_COMMAND, command)
            putExtra(ConnectionService.EXTRA_GOAL_CONFIRMED, confirmed)
            putExtra(ConnectionService.EXTRA_REQUEST_ID, UUID.randomUUID().toString())
        })
    }

    private fun checkForUpdates(showLatestMessage: Boolean) {
        lastAutomaticUpdateCheckAt = System.currentTimeMillis()
        val pairings = MonitorStore.pairings()
        if (pairings.isEmpty()) {
            if (showLatestMessage) Toast.makeText(this, "请先连接一台电脑", Toast.LENGTH_SHORT).show()
            return
        }
        updatePhase = UpdatePhase.CHECKING
        AppUpdater.check(this, pairings) { result ->
            result.onSuccess { offer ->
                if (offer == null) {
                    updatePhase = UpdatePhase.IDLE
                    if (showLatestMessage) Toast.makeText(this, "当前已是最新版本", Toast.LENGTH_SHORT).show()
                } else {
                    applyUpdateMigration(offer)
                    if (offer.migrationOnly) {
                        updatePhase = UpdatePhase.IDLE
                    } else {
                        updateOffer = offer
                        updatePhase = UpdatePhase.AVAILABLE
                    }
                }
            }.onFailure {
                updatePhase = UpdatePhase.IDLE
                if (showLatestMessage) Toast.makeText(this, "暂时无法检查更新，请确认电脑端在线", Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun applyUpdateMigration(offer: UpdateOffer) {
        if (!MonitorStore.replacePairing(offer.pairing)) return
        startService(Intent(this, ConnectionService::class.java).apply {
            action = ConnectionService.ACTION_CONNECT
            putExtra(ConnectionService.EXTRA_DEVICE_ID, offer.pairing.id)
        })
    }

    private fun downloadUpdate() {
        val offer = updateOffer ?: return
        updatePhase = UpdatePhase.DOWNLOADING
        AppUpdater.download(this, offer) { result ->
            result.onSuccess { file ->
                updatePhase = UpdatePhase.IDLE
                requestInstall(file)
            }.onFailure {
                updatePhase = UpdatePhase.AVAILABLE
                Toast.makeText(this, it.message ?: "更新下载失败", Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun requestInstall(file: File) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !packageManager.canRequestPackageInstalls()) {
            pendingInstall = file
            Toast.makeText(this, "请允许 Codex Monitor 安装更新", Toast.LENGTH_LONG).show()
            startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName")))
            return
        }
        launchInstaller(file)
    }

    private fun launchInstaller(file: File) {
        val uri = FileProvider.getUriForFile(this, "$packageName.updates", file)
        startActivity(Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        })
    }
}

@Composable
private fun CodexTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = MaterialTheme.colorScheme.copy(
            primary = Ink,
            background = Canvas,
            surface = Color.White,
            onBackground = Ink,
            onSurface = Ink,
        ),
        content = content,
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun MonitorScreen(
    onScan: () -> Unit,
    onDisconnect: (String) -> Unit,
    onConnectionPreferenceChange: (String, ConnectionPreference) -> Unit,
    onMonitoringChange: (Boolean) -> Unit,
    backgroundProtected: Boolean,
    exactAlarmsAllowed: Boolean,
    notificationsAllowed: Boolean,
    onNotificationSettings: () -> Unit,
    onBatterySettings: () -> Unit,
    onExactAlarmSettings: () -> Unit,
    onAutoStartSettings: () -> Unit,
    updatePhase: UpdatePhase,
    updateOffer: UpdateOffer?,
    onCheckUpdate: () -> Unit,
    onInstallUpdate: () -> Unit,
    onDismissUpdate: () -> Unit,
    onSendGuidance: (String, String, String, String, List<GuidanceAttachment>) -> Unit,
    onGoalCommand: (String, String, String, Boolean) -> Unit,
) {
    val context = LocalContext.current
    val devices by MonitorStore.devices.collectAsStateWithLifecycle()
    val monitoringEnabled by MonitorStore.monitoringEnabled.collectAsStateWithLifecycle()
    val templates by MonitorStore.templates.collectAsStateWithLifecycle()
    val guidanceStatus by MonitorStore.guidanceStatus.collectAsStateWithLifecycle()
    val goalCommandStatus by MonitorStore.goalCommandStatus.collectAsStateWithLifecycle()
    val backgroundDiagnostic by MonitorStore.backgroundDiagnostic.collectAsStateWithLifecycle()
    val jarvisSessionKeys by MonitorStore.jarvisSessionKeys.collectAsStateWithLifecycle()
    val connectionPreferences by MonitorStore.connectionPreferences.collectAsStateWithLifecycle()
    var selectedSession by remember { mutableStateOf<SessionTarget?>(null) }
    var showBackgroundProtection by remember { mutableStateOf(false) }
    Scaffold(
        containerColor = Canvas,
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("Codex Monitor", fontSize = 20.sp, fontWeight = FontWeight.Bold)
                        Text("${devices.count { it.connected }} 台在线 · ${devices.sumOf { it.sessions.size }} 个会话", fontSize = 12.sp, color = Muted)
                    }
                },
                actions = {
                    IconButton(onClick = onCheckUpdate, enabled = updatePhase == UpdatePhase.IDLE) {
                        if (updatePhase == UpdatePhase.CHECKING) {
                            CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp, color = Ink)
                        } else {
                            Icon(Icons.Outlined.SystemUpdate, contentDescription = "检查更新")
                        }
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Canvas),
            )
        },
        floatingActionButton = {
            FloatingActionButton(onClick = onScan, containerColor = Ink, contentColor = Color.White, shape = RoundedCornerShape(8.dp)) {
                Icon(Icons.Outlined.QrCodeScanner, contentDescription = "扫码连接")
            }
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            MonitoringControl(
                enabled = monitoringEnabled,
                onChange = onMonitoringChange,
                onBackgroundProtection = { showBackgroundProtection = true },
            )
            if (monitoringEnabled && (!backgroundProtected || !exactAlarmsAllowed || !notificationsAllowed)) {
                BackgroundProtectionWarning(
                    batteryProtected = backgroundProtected,
                    exactAlarmsAllowed = exactAlarmsAllowed,
                    notificationsAllowed = notificationsAllowed,
                    onOpenSettings = { showBackgroundProtection = true },
                )
            }
            backgroundDiagnostic?.let { message ->
                BackgroundFreezeWarning(message = message, onRepair = { showBackgroundProtection = true })
            }
            if (devices.isEmpty()) {
                EmptyState(onScan, Modifier.weight(1f))
            } else {
                LazyColumn(
                    modifier = Modifier.fillMaxWidth().weight(1f),
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(bottom = 96.dp),
                ) {
                    items(devices, key = { it.pairing.id }) { device ->
                        DeviceSection(
                            device = device,
                            monitoringEnabled = monitoringEnabled,
                            onDisconnect = onDisconnect,
                            connectionPreference = connectionPreferences[device.pairing.id] ?: ConnectionPreference.AUTOMATIC,
                            onConnectionPreferenceChange = onConnectionPreferenceChange,
                            onClearNew = MonitorStore::clearNew,
                            jarvisSessionKeys = jarvisSessionKeys,
                            onOpenSession = { session -> selectedSession = SessionTarget(device.pairing, session) },
                        )
                        Divider(color = Color(0xFFDCE2DF), thickness = 1.dp)
                    }
                }
            }
        }
    }
    if (updatePhase == UpdatePhase.AVAILABLE && updateOffer != null) {
        AlertDialog(
            onDismissRequest = onDismissUpdate,
            title = { Text("发现新版本 ${updateOffer.manifest.versionName}") },
            text = { Text("将从 ${updateOffer.pairing.name} 下载并校验安装包。安装前需要在安卓系统页面确认一次。") },
            confirmButton = { TextButton(onClick = onInstallUpdate) { Text("更新") } },
            dismissButton = { TextButton(onClick = onDismissUpdate) { Text("稍后") } },
        )
    }
    if (showBackgroundProtection) {
        BackgroundProtectionDialog(
            batteryProtected = backgroundProtected,
            exactAlarmsAllowed = exactAlarmsAllowed,
            notificationsAllowed = notificationsAllowed,
            manufacturer = BackgroundProtection.manufacturerLabel(),
            onNotificationSettings = onNotificationSettings,
            onBatterySettings = onBatterySettings,
            onExactAlarmSettings = onExactAlarmSettings,
            onAutoStartSettings = onAutoStartSettings,
            onDismiss = { showBackgroundProtection = false },
        )
    }
    if (updatePhase == UpdatePhase.DOWNLOADING) {
        AlertDialog(
            onDismissRequest = {},
            title = { Text("正在下载更新") },
            text = {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(modifier = Modifier.size(24.dp), strokeWidth = 2.dp)
                    Text("安装包下载并校验中…", modifier = Modifier.padding(start = 14.dp))
                }
            },
            confirmButton = {},
        )
    }
    val currentTarget = selectedSession?.let { target ->
        val device = devices.firstOrNull { it.pairing.id == target.pairing.id }
        val session = device?.sessions?.firstOrNull { it.id == target.session.id }
        if (device != null && session != null) {
            SessionTarget(device.pairing, session)
        } else {
            target
        }
    }
    currentTarget?.let { target ->
        GuidanceDialog(
            target = target,
            templates = templates,
            status = guidanceStatus["${target.pairing.id}:${target.session.id}"],
            goalCommandStatus = goalCommandStatus["${target.pairing.id}:${target.session.id}"],
            isJarvis = MonitorStore.isJarvisSession(target.pairing.id, target.session.id),
            onJarvisChange = {
                MonitorStore.setJarvisSession(target.pairing.id, target.session.id, it)
                PushRegistrationManager.registerAll(context)
            },
            onSaveTemplates = MonitorStore::saveTemplates,
            onSend = { text, mode, attachments ->
                onSendGuidance(target.pairing.id, target.session.id, text, mode, attachments)
            },
            onGoalCommand = { command, confirmed ->
                onGoalCommand(target.pairing.id, target.session.id, command, confirmed)
            },
            onDismiss = { selectedSession = null },
        )
    }
}

@Composable
private fun BackgroundProtectionDialog(
    batteryProtected: Boolean,
    exactAlarmsAllowed: Boolean,
    notificationsAllowed: Boolean,
    manufacturer: String,
    onNotificationSettings: () -> Unit,
    onBatterySettings: () -> Unit,
    onExactAlarmSettings: () -> Unit,
    onAutoStartSettings: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("后台保护设置") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("请逐项完成。否则切到 B 站等应用后，Android 可能暂停监控，提醒只能在重新打开时补收。", color = Muted, fontSize = 13.sp)
                ProtectionSettingRow(
                    title = "通知与声音",
                    detail = if (notificationsAllowed) "已允许" else "未允许，无法弹窗或播放提示音",
                    complete = notificationsAllowed,
                    button = "去设置",
                    onClick = onNotificationSettings,
                )
                ProtectionSettingRow(
                    title = "关闭电池优化",
                    detail = if (batteryProtected) "已设为不受限制" else "需要允许 Codex Monitor 忽略电池优化",
                    complete = batteryProtected,
                    button = if (batteryProtected) "查看" else "去允许",
                    onClick = onBatterySettings,
                )
                ProtectionSettingRow(
                    title = "允许精确保活",
                    detail = if (exactAlarmsAllowed) {
                        "已允许；后台被冻结时系统可按时唤醒监控服务"
                    } else {
                        "未允许；vivo 可能把 60 秒提示和重连延后数分钟"
                    },
                    complete = exactAlarmsAllowed,
                    button = if (exactAlarmsAllowed) "查看" else "去允许",
                    onClick = onExactAlarmSettings,
                )
                ProtectionSettingRow(
                    title = "自启动与后台运行",
                    detail = if (manufacturer.contains("vivo", ignoreCase = true)) {
                        "请允许自启动；再到“电池 → 后台耗电管理”把 Codex Monitor 设为允许后台高耗电"
                    } else {
                        "$manufacturer 系统无法由应用自动读取，请在系统页允许自启动、后台活动，并关闭自动休眠"
                    },
                    complete = null,
                    button = "去确认",
                    onClick = onAutoStartSettings,
                )
                Text("提示：系统“强行停止”应用后，任何局域网监控都无法自行恢复；公网推送功能完成后才能覆盖这种情况。", color = Muted, fontSize = 12.sp)
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("完成") } },
    )
}

@Composable
private fun ProtectionSettingRow(
    title: String,
    detail: String,
    complete: Boolean?,
    button: String,
    onClick: () -> Unit,
) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(
            imageVector = if (complete == true) Icons.Outlined.CheckCircle else Icons.Outlined.WarningAmber,
            contentDescription = null,
            tint = if (complete == true) Green else Color(0xFFB56B00),
            modifier = Modifier.size(22.dp),
        )
        Column(Modifier.weight(1f).padding(horizontal = 9.dp)) {
            Text(title, color = Ink, fontSize = 14.sp, fontWeight = FontWeight.Bold)
            Text(detail, color = Muted, fontSize = 12.sp)
        }
        OutlinedButton(onClick = onClick) { Text(button) }
    }
}

@Composable
private fun BackgroundProtectionWarning(
    batteryProtected: Boolean,
    exactAlarmsAllowed: Boolean,
    notificationsAllowed: Boolean,
    onOpenSettings: () -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth().background(Color(0xFFFFF4DE)).padding(horizontal = 20.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text("后台提醒尚未完整授权", color = Ink, fontSize = 13.sp, fontWeight = FontWeight.Bold)
            Text(
                when {
                    !notificationsAllowed -> "系统通知已关闭，状态变化无法弹窗或播放提示音"
                    !batteryProtected -> "需要允许忽略电池优化，避免刷视频时服务被冻结"
                    !exactAlarmsAllowed -> "需要允许精确闹钟，让系统按时唤醒 60 秒提醒和重连"
                    else -> "请检查系统后台运行设置"
                },
                color = Muted,
                fontSize = 12.sp,
            )
        }
        TextButton(onClick = onOpenSettings) {
            Icon(Icons.Outlined.Settings, contentDescription = null, modifier = Modifier.size(17.dp))
            Spacer(Modifier.size(5.dp))
            Text("设置")
        }
    }
}

@Composable
private fun BackgroundFreezeWarning(message: String, onRepair: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().background(Color(0xFFFFE5E5)).padding(horizontal = 20.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text("后台保活失败记录", color = Red, fontSize = 13.sp, fontWeight = FontWeight.Bold)
            Text(message, color = Ink, fontSize = 12.sp)
        }
        TextButton(onClick = onRepair) {
            Icon(Icons.Outlined.Settings, contentDescription = null, modifier = Modifier.size(17.dp))
            Spacer(Modifier.size(5.dp))
            Text("去修复")
        }
    }
}

@Composable
private fun MonitoringControl(
    enabled: Boolean,
    onChange: (Boolean) -> Unit,
    onBackgroundProtection: () -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth().background(Color.White).padding(horizontal = 20.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text("会话监控", color = Ink, fontSize = 15.sp, fontWeight = FontWeight.Bold)
            Text(if (enabled) "正在连接并接收状态变化" else "已暂停，不连接设备", color = Muted, fontSize = 12.sp)
        }
        IconButton(onClick = onBackgroundProtection) {
            Icon(Icons.Outlined.Settings, contentDescription = "后台保护设置")
        }
        Switch(checked = enabled, onCheckedChange = onChange)
    }
}

@Composable
private fun EmptyState(onScan: () -> Unit, modifier: Modifier = Modifier) {
    Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Icon(Icons.Outlined.Computer, contentDescription = null, tint = Muted, modifier = Modifier.size(42.dp))
            Spacer(Modifier.height(14.dp))
            Text("尚未连接设备", color = Ink, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(18.dp))
            Button(onClick = onScan, colors = ButtonDefaults.buttonColors(containerColor = Ink), shape = RoundedCornerShape(7.dp)) {
                Icon(Icons.Outlined.QrCodeScanner, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.size(8.dp))
                Text("扫码连接")
            }
        }
    }
}

@Composable
private fun DeviceSection(
    device: DeviceUi,
    monitoringEnabled: Boolean,
    onDisconnect: (String) -> Unit,
    connectionPreference: ConnectionPreference,
    onConnectionPreferenceChange: (String, ConnectionPreference) -> Unit,
    onClearNew: (String, String) -> Unit,
    jarvisSessionKeys: Set<String>,
    onOpenSession: (SessionStatus) -> Unit,
) {
    var connectionMenuExpanded by remember(device.pairing.id) { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().background(Color.White).padding(horizontal = 20.dp, vertical = 16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(10.dp).background(if (device.connected) Green else Black, CircleShape))
            Column(Modifier.weight(1f).padding(start = 11.dp)) {
                Text(device.pairing.name, fontSize = 15.sp, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(
                    if (device.connected) "已连接 · ${formatTime(device.lastSeenMs)}"
                    else if (monitoringEnabled) "状态未知，正在重连"
                    else "监控已关闭",
                    fontSize = 12.sp,
                    color = Muted,
                )
            }
            Box {
                TextButton(onClick = { connectionMenuExpanded = true }) {
                    Text(connectionPreference.label, fontSize = 11.sp)
                    Icon(Icons.Outlined.KeyboardArrowDown, contentDescription = "选择连接方式", modifier = Modifier.size(16.dp))
                }
                DropdownMenu(expanded = connectionMenuExpanded, onDismissRequest = { connectionMenuExpanded = false }) {
                    ConnectionPreference.entries.forEach { preference ->
                        DropdownMenuItem(
                            text = { Text(preference.label) },
                            enabled = preference != ConnectionPreference.RELAY || device.pairing.hasRelay(),
                            onClick = {
                                connectionMenuExpanded = false
                                onConnectionPreferenceChange(device.pairing.id, preference)
                            },
                        )
                    }
                }
            }
            TextButton(onClick = { onDisconnect(device.pairing.id) }) {
                Icon(Icons.Outlined.LinkOff, contentDescription = null, modifier = Modifier.size(17.dp))
                Spacer(Modifier.size(5.dp))
                Text("断开")
            }
        }
        Spacer(Modifier.height(13.dp))
        if (device.sessions.isEmpty()) {
            Text("电脑端尚未选择会话", color = Muted, fontSize = 13.sp, modifier = Modifier.padding(vertical = 12.dp))
        } else {
            device.sessions.sortedByDescending { "${device.pairing.id}:${it.id}" in jarvisSessionKeys }.forEachIndexed { index, session ->
                if (index > 0) Divider(color = Color(0xFFEDF0EF))
                SessionRow(
                    session = session,
                    deviceConnected = device.connected,
                    isNew = session.id in device.newSessionIds,
                    isJarvis = "${device.pairing.id}:${session.id}" in jarvisSessionKeys,
                    onClearNew = { onClearNew(device.pairing.id, session.id) },
                    onOpen = { onOpenSession(session) },
                )
            }
        }
    }
}

@Composable
private fun SessionRow(
    session: SessionStatus,
    deviceConnected: Boolean,
    isNew: Boolean,
    isJarvis: Boolean,
    onClearNew: () -> Unit,
    onOpen: () -> Unit,
) {
    val newPulse = rememberInfiniteTransition(label = "new-pulse")
    val newAlpha by newPulse.animateFloat(
        initialValue = 1f,
        targetValue = 0.22f,
        animationSpec = infiniteRepeatable(animation = tween(700), repeatMode = RepeatMode.Reverse),
        label = "new-alpha",
    )
    val visibleState = if (deviceConnected) session.state else "unknown"
    val (color, label) = when (visibleState) {
        "running" -> Green to "运行中"
        "blocked" -> Red to "受阻"
        "completed" -> Blue to "已完成"
        else -> Black to "未知"
    }
    Row(
        Modifier.fillMaxWidth().clickable {
            if (isNew) onClearNew()
            onOpen()
        }.padding(vertical = 13.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Box(Modifier.padding(top = 4.dp).size(11.dp).background(color, CircleShape))
        Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (isJarvis) {
                    Icon(Icons.Outlined.HealthAndSafety, contentDescription = "贾维斯健康管家", tint = Green, modifier = Modifier.size(17.dp))
                    Spacer(Modifier.size(5.dp))
                }
                Text(session.title, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            Spacer(Modifier.height(4.dp))
            Text(session.message, fontSize = 12.sp, color = Muted, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        Column(horizontalAlignment = Alignment.End) {
            Text(label, fontSize = 12.sp, color = color, fontWeight = FontWeight.Medium)
            if (isNew) {
                Spacer(Modifier.height(6.dp))
                Text(
                    "NEW",
                    fontSize = 10.sp,
                    color = Blue,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier
                        .alpha(newAlpha)
                        .background(Blue.copy(alpha = 0.14f), RoundedCornerShape(4.dp))
                        .padding(horizontal = 5.dp, vertical = 2.dp),
                )
            }
        }
    }
}

@Composable
private fun GuidanceDialog(
    target: SessionTarget,
    templates: List<String>,
    status: GuidanceUi?,
    goalCommandStatus: GoalCommandUi?,
    isJarvis: Boolean,
    onJarvisChange: (Boolean) -> Unit,
    onSaveTemplates: (List<String>) -> Unit,
    onSend: (String, String, List<GuidanceAttachment>) -> Unit,
    onGoalCommand: (String, Boolean) -> Unit,
    onDismiss: () -> Unit,
) {
    var input by remember(target.session.id) { mutableStateOf("") }
    var mode by remember(target.session.id) { mutableStateOf("steer") }
    var editingTemplates by remember(target.session.id) { mutableStateOf(false) }
    var templateMenuExpanded by remember(target.session.id) { mutableStateOf(false) }
    var draftTemplates by remember(templates, editingTemplates) { mutableStateOf(templates) }
    var attachments by remember(target.session.id) { mutableStateOf<List<GuidanceAttachment>>(emptyList()) }
    var lastSentInput by remember(target.pairing.id, target.session.id) {
        mutableStateOf(MonitorStore.lastSentGuidance(target.pairing.id, target.session.id))
    }
    var preparingImages by remember(target.session.id) { mutableStateOf(false) }
    var imageError by remember(target.session.id) { mutableStateOf<String?>(null) }
    var confirmGoalDelete by remember(target.session.id) { mutableStateOf(false) }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val imagePicker = rememberLauncherForActivityResult(
        ActivityResultContracts.PickMultipleVisualMedia(GuidanceImages.MAX_IMAGES),
    ) { uris ->
        if (uris.isEmpty()) return@rememberLauncherForActivityResult
        preparingImages = true
        imageError = null
        scope.launch {
            runCatching { withContext(Dispatchers.IO) { GuidanceImages.prepare(context, uris) } }
                .onSuccess { attachments = it }
                .onFailure { imageError = it.message ?: "图片处理失败" }
            preparingImages = false
        }
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Column {
                Text(target.session.title, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text(target.pairing.name, fontSize = 12.sp, color = Muted)
                status?.let { result ->
                    Spacer(Modifier.height(5.dp))
                    Text(
                        result.message,
                        fontSize = 12.sp,
                        color = when (result.ok) { true -> Green; false -> Red; null -> Muted },
                    )
                }
            }
        },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Outlined.HealthAndSafety, contentDescription = null, tint = Green, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.size(7.dp))
                    Column(Modifier.weight(1f)) {
                        Text("作为贾维斯管家", fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                        Text("置顶显示；仅“运行中 → 已完成”巡检结果静默，明确受阻仍会提醒", fontSize = 11.sp, color = Muted)
                    }
                    Switch(checked = isJarvis, onCheckedChange = onJarvisChange)
                }
                target.session.goal?.let { goal ->
                    Spacer(Modifier.height(10.dp))
                    GoalSummary(goal)
                }
                Spacer(Modifier.height(14.dp))
                if (editingTemplates) {
                    Text("编辑引导模板", fontWeight = FontWeight.SemiBold)
                    Spacer(Modifier.height(8.dp))
                    draftTemplates.forEachIndexed { index, value ->
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            OutlinedTextField(
                                value = value,
                                onValueChange = { changed -> draftTemplates = draftTemplates.toMutableList().also { it[index] = changed } },
                                label = { Text("模板 ${index + 1}") },
                                modifier = Modifier.weight(1f),
                            )
                            IconButton(onClick = { draftTemplates = draftTemplates.filterIndexed { itemIndex, _ -> itemIndex != index } }) {
                                Icon(Icons.Outlined.Delete, contentDescription = "删除模板")
                            }
                        }
                        Spacer(Modifier.height(6.dp))
                    }
                    TextButton(
                        onClick = { draftTemplates = draftTemplates + "" },
                        enabled = draftTemplates.size < 8,
                    ) {
                        Icon(Icons.Outlined.Add, contentDescription = null, modifier = Modifier.size(17.dp))
                        Text("添加模板")
                    }
                } else {
                    Text("最近工作内容", fontWeight = FontWeight.SemiBold)
                    Spacer(Modifier.height(7.dp))
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(min = 96.dp, max = 180.dp)
                            .background(Canvas, RoundedCornerShape(6.dp))
                            .border(1.dp, Color(0xFFD8DEDB), RoundedCornerShape(6.dp))
                            .verticalScroll(rememberScrollState())
                            .padding(12.dp),
                    ) {
                        Text(
                            target.session.message.ifBlank { "暂无工作内容" },
                            fontSize = 13.sp,
                            color = if (target.session.message.isBlank()) Muted else Ink,
                        )
                    }
                    if (target.session.evidence.isNotEmpty()) {
                        Spacer(Modifier.height(9.dp))
                        EvidenceGallery(pairing = target.pairing, images = target.session.evidence)
                    }
                    Spacer(Modifier.height(10.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box {
                            OutlinedButton(onClick = { templateMenuExpanded = true }) {
                                Text("选择模板")
                                Icon(
                                    Icons.Outlined.KeyboardArrowDown,
                                    contentDescription = null,
                                    modifier = Modifier.size(18.dp),
                                )
                            }
                            DropdownMenu(
                                expanded = templateMenuExpanded,
                                onDismissRequest = { templateMenuExpanded = false },
                            ) {
                                templates.forEach { template ->
                                    DropdownMenuItem(
                                        text = { Text(template, maxLines = 2, overflow = TextOverflow.Ellipsis) },
                                        onClick = {
                                            input = template
                                            templateMenuExpanded = false
                                        },
                                    )
                                }
                            }
                        }
                        TextButton(onClick = { editingTemplates = true }) { Text("编辑模板") }
                    }
                    Box(Modifier.fillMaxWidth()) {
                        OutlinedTextField(
                            value = input,
                            onValueChange = { input = it.take(2000) },
                            label = { Text("给 Codex 的引导消息") },
                            minLines = 3,
                            maxLines = 6,
                            modifier = Modifier.fillMaxWidth(),
                        )
                        IconButton(
                            onClick = { input = "" },
                            enabled = input.isNotEmpty(),
                            modifier = Modifier.align(Alignment.BottomEnd).padding(end = 2.dp, bottom = 2.dp),
                        ) {
                            Icon(Icons.Outlined.Delete, contentDescription = "清空输入")
                        }
                        IconButton(
                            onClick = { input = lastSentInput.orEmpty() },
                            enabled = input.isBlank() && !lastSentInput.isNullOrBlank(),
                            modifier = Modifier.align(Alignment.BottomEnd).padding(end = 46.dp, bottom = 2.dp),
                        ) {
                            Icon(Icons.AutoMirrored.Outlined.Undo, contentDescription = "恢复上一条发送内容")
                        }
                    }
                    Spacer(Modifier.height(8.dp))
                    OutlinedButton(
                        onClick = {
                            imagePicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                        },
                        enabled = !preparingImages,
                    ) {
                        Icon(Icons.Outlined.Image, contentDescription = null, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.size(7.dp))
                        Text(if (preparingImages) "正在处理图片" else "添加截图（最多 10 张）")
                    }
                    if (attachments.isNotEmpty()) {
                        Spacer(Modifier.height(8.dp))
                        attachments.forEachIndexed { index, attachment ->
                            AttachmentPreview(
                                attachment = attachment,
                                onRemove = { attachments = attachments.filterIndexed { itemIndex, _ -> itemIndex != index } },
                            )
                            if (index < attachments.lastIndex) Spacer(Modifier.height(6.dp))
                        }
                    }
                    imageError?.let {
                        Spacer(Modifier.height(6.dp))
                        Text(it, color = Red, fontSize = 12.sp)
                    }
                    Spacer(Modifier.height(12.dp))
                    SingleChoiceSegmentedButtonRow(modifier = Modifier.fillMaxWidth()) {
                        listOf("steer" to "引导当前", "queue" to "排队下一轮").forEachIndexed { index, option ->
                            SegmentedButton(
                                selected = mode == option.first,
                                onClick = { mode = option.first },
                                shape = SegmentedButtonDefaults.itemShape(index = index, count = 2),
                            ) { Text(option.second, fontSize = 12.sp) }
                        }
                    }
                    target.session.goal?.let { goal ->
                        Spacer(Modifier.height(18.dp))
                        GoalControls(
                            goal = goal,
                            sessionRunning = target.session.state == "running",
                            sending = goalCommandStatus?.sending == true,
                            onResume = { onGoalCommand("resume", false) },
                            onDelete = { confirmGoalDelete = true },
                        )
                        goalCommandStatus?.let { result ->
                            Spacer(Modifier.height(6.dp))
                            Text(
                                result.message,
                                fontSize = 12.sp,
                                color = when (result.ok) { true -> Green; false -> Red; null -> Muted },
                            )
                        }
                    }
                }
            }
        },
        confirmButton = {
            if (editingTemplates) {
                TextButton(onClick = {
                    onSaveTemplates(draftTemplates)
                    editingTemplates = false
                }) { Text("保存模板") }
            } else {
                TextButton(
                    onClick = {
                        val submittedText = input.trim()
                        MonitorStore.rememberLastSentGuidance(target.pairing.id, target.session.id, submittedText)
                        lastSentInput = submittedText.takeIf { it.isNotEmpty() }
                        onSend(submittedText, mode, attachments)
                        input = ""
                        attachments = emptyList()
                        imageError = null
                    },
                    enabled = (input.isNotBlank() || attachments.isNotEmpty()) && !preparingImages && status?.sending != true,
                ) {
                    Text(if (status?.sending == true) "发送中" else "发送")
                }
            }
        },
        dismissButton = {
            TextButton(onClick = { if (editingTemplates) editingTemplates = false else onDismiss() }) {
                Text(if (editingTemplates) "取消编辑" else "关闭")
            }
        },
    )
    if (confirmGoalDelete) {
        AlertDialog(
            onDismissRequest = { confirmGoalDelete = false },
            title = { Text("删除这个 Goal？") },
            text = { Text("只删除 Goal 目标关联，不会删除 Codex 会话、聊天记录或工作文件。") },
            confirmButton = {
                TextButton(onClick = {
                    confirmGoalDelete = false
                    onGoalCommand("delete", true)
                }) { Text("确认删除", color = Red) }
            },
            dismissButton = { TextButton(onClick = { confirmGoalDelete = false }) { Text("取消") } },
        )
    }
}

@Composable
private fun EvidenceGallery(pairing: PairingData, images: List<EvidenceImage>) {
    var selected by remember(images) { mutableStateOf<Pair<EvidenceImage, android.graphics.Bitmap>?>(null) }
    var retryVersion by remember(images) { mutableStateOf(0) }
    Column {
        Text("重要证据 · ${images.size} 张", color = Muted, fontSize = 12.sp)
        Spacer(Modifier.height(6.dp))
        Row(
            modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            images.take(10).forEach { evidence ->
                val loaded by produceState<Result<android.graphics.Bitmap>?>(initialValue = null, pairing.id, evidence.id, retryVersion) {
                    value = runCatching { EvidenceImages.load(pairing, evidence) }
                }
                val bitmap = loaded?.getOrNull()
                Box(
                    modifier = Modifier
                        .size(72.dp)
                        .background(Canvas, RoundedCornerShape(6.dp))
                        .border(1.dp, Color(0xFFD8DEDB), RoundedCornerShape(6.dp))
                        .clickable(enabled = bitmap != null) { bitmap?.let { selected = evidence to it } },
                    contentAlignment = Alignment.Center,
                ) {
                    if (loaded == null) {
                        CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                    } else if (bitmap == null) {
                        TextButton(onClick = { retryVersion += 1 }) {
                            Text("重试", color = Red, fontSize = 11.sp)
                        }
                    } else {
                        Image(
                            bitmap = bitmap!!.asImageBitmap(),
                            contentDescription = evidence.name,
                            modifier = Modifier.fillMaxSize(),
                            contentScale = ContentScale.Crop,
                        )
                    }
                }
            }
        }
    }
    selected?.let { (evidence, bitmap) ->
        AlertDialog(
            onDismissRequest = { selected = null },
            title = { Text(evidence.name, maxLines = 2, overflow = TextOverflow.Ellipsis) },
            text = {
                Image(
                    bitmap = bitmap.asImageBitmap(),
                    contentDescription = evidence.name,
                    modifier = Modifier.fillMaxWidth().heightIn(max = 560.dp),
                    contentScale = ContentScale.Fit,
                )
            },
            confirmButton = { TextButton(onClick = { selected = null }) { Text("关闭") } },
        )
    }
}

@Composable
private fun GoalControls(
    goal: GoalInfo,
    sessionRunning: Boolean,
    sending: Boolean,
    onResume: () -> Unit,
    onDelete: () -> Unit,
) {
    val label = GoalPresentation.label(goal.status)
    val canResume = GoalPresentation.canResume(goal.status, sessionRunning)
    Column(
        Modifier.fillMaxWidth().background(Color(0xFFF2F5F4), RoundedCornerShape(6.dp)).padding(10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Goal · $label", fontSize = 13.sp, fontWeight = FontWeight.Bold)
                Text(
                    if (sessionRunning) "会话正在执行" else "会话当前空闲",
                    fontSize = 11.sp,
                    color = Muted,
                )
                if (goal.objective.isNotBlank()) {
                    Text(goal.objective, fontSize = 12.sp, color = Muted, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
            }
        }
        Spacer(Modifier.height(7.dp))
        Row {
            OutlinedButton(onClick = onResume, enabled = canResume && !sending) {
                Icon(Icons.Outlined.RestartAlt, contentDescription = null, modifier = Modifier.size(17.dp))
                Spacer(Modifier.size(5.dp))
                Text(
                    when {
                        goal.status == "paused" -> "恢复 Goal"
                        sessionRunning -> "仍在运行"
                        goal.status == "active" -> "继续 Goal"
                        else -> "重启 Goal"
                    },
                )
            }
            Spacer(Modifier.size(8.dp))
            OutlinedButton(onClick = onDelete, enabled = !sending) {
                Icon(Icons.Outlined.Delete, contentDescription = null, modifier = Modifier.size(17.dp), tint = Red)
                Spacer(Modifier.size(5.dp))
                Text("删除 Goal", color = Red)
            }
        }
    }
}

@Composable
private fun GoalSummary(goal: GoalInfo) {
    Column(
        Modifier.fillMaxWidth().background(Color(0xFFEAF3FF), RoundedCornerShape(6.dp)).padding(10.dp),
    ) {
        Text(
            "Goal · ${GoalPresentation.label(goal.status)}",
            color = Blue,
            fontSize = 13.sp,
            fontWeight = FontWeight.Bold,
        )
        if (goal.objective.isNotBlank()) {
            Text(
                goal.objective,
                color = Ink,
                fontSize = 12.sp,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Text("重启和删除控制在页面下方", color = Muted, fontSize = 11.sp)
    }
}

@Composable
private fun AttachmentPreview(attachment: GuidanceAttachment, onRemove: () -> Unit) {
    val bitmap = remember(attachment.dataBase64) {
        val bytes = Base64.decode(attachment.dataBase64, Base64.DEFAULT)
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()
    }
    Row(
        modifier = Modifier.fillMaxWidth().border(1.dp, Color(0xFFD8DEDB), RoundedCornerShape(6.dp)).padding(7.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        bitmap?.let {
            Image(
                bitmap = it,
                contentDescription = attachment.name,
                modifier = Modifier.size(54.dp).background(Canvas, RoundedCornerShape(4.dp)),
                contentScale = ContentScale.Crop,
            )
        }
        Text(attachment.name, modifier = Modifier.weight(1f).padding(horizontal = 9.dp), fontSize = 12.sp, maxLines = 2)
        IconButton(onClick = onRemove) {
            Icon(Icons.Outlined.Delete, contentDescription = "移除图片")
        }
    }
}

private fun formatTime(value: Long?): String {
    if (value == null) return "等待数据"
    return SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date(value))
}
