package com.codexmonitor.mobile

/** Notification behavior for the explicitly selected supervision session. */
object JarvisNotificationPolicy {
    fun isSilentCompletion(isJarvis: Boolean, previousState: String, currentState: String): Boolean =
        isJarvis && previousState == "running" && currentState == "completed"
}
