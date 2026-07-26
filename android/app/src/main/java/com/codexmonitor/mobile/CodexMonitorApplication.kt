package com.codexmonitor.mobile

import android.app.Activity
import android.app.Application
import android.os.Bundle
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging

object AppVisibility {
    @Volatile var foreground: Boolean = false
        private set

    internal fun setForeground(value: Boolean) {
        foreground = value
    }
}

class CodexMonitorApplication : Application(), Application.ActivityLifecycleCallbacks {
    private var startedActivities = 0

    override fun onCreate() {
        super.onCreate()
        MonitorStore.initialize(this)
        registerActivityLifecycleCallbacks(this)
        initializeFcm()
    }

    private fun initializeFcm() {
        if (listOf(BuildConfig.FCM_APP_ID, BuildConfig.FCM_API_KEY, BuildConfig.FCM_PROJECT_ID, BuildConfig.FCM_SENDER_ID).any(String::isBlank)) return
        val options = FirebaseOptions.Builder()
            .setApplicationId(BuildConfig.FCM_APP_ID)
            .setApiKey(BuildConfig.FCM_API_KEY)
            .setProjectId(BuildConfig.FCM_PROJECT_ID)
            .setGcmSenderId(BuildConfig.FCM_SENDER_ID)
            .build()
        runCatching { FirebaseApp.initializeApp(this, options) }.getOrNull() ?: return
        FirebaseMessaging.getInstance().token.addOnSuccessListener { PushRegistrationManager.storeTokenAndRegister(this, it) }
    }

    override fun onActivityStarted(activity: Activity) {
        startedActivities += 1
        AppVisibility.setForeground(true)
    }

    override fun onActivityStopped(activity: Activity) {
        startedActivities = (startedActivities - 1).coerceAtLeast(0)
        AppVisibility.setForeground(startedActivities > 0)
    }

    override fun onActivityCreated(activity: Activity, state: Bundle?) = Unit
    override fun onActivityResumed(activity: Activity) = Unit
    override fun onActivityPaused(activity: Activity) = Unit
    override fun onActivitySaveInstanceState(activity: Activity, state: Bundle) = Unit
    override fun onActivityDestroyed(activity: Activity) = Unit
}
