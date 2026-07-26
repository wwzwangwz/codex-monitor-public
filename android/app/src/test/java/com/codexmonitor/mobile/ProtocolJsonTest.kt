package com.codexmonitor.mobile

import kotlinx.serialization.encodeToString
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.jsonArray
import org.junit.Assert.assertEquals
import org.junit.Test

class ProtocolJsonTest {
    @Test
    fun responseValidationRejectsCrossSessionAndWrongGoalCommandResults() {
        assertEquals(true, ResponseValidationPolicy.guidanceMatches("s1", "s1"))
        assertEquals(false, ResponseValidationPolicy.guidanceMatches("s1", "s2"))
        assertEquals(true, ResponseValidationPolicy.goalMatches("s1", "s1", "resume", "resume"))
        assertEquals(true, ResponseValidationPolicy.goalMatches("s1", "s1", "resume", ""))
        assertEquals(false, ResponseValidationPolicy.goalMatches("s1", "s2", "resume", "resume"))
        assertEquals(false, ResponseValidationPolicy.goalMatches("s1", "s1", "resume", "delete"))
    }

    @Test
    fun persistedLampStateRestoresOnlyWhenNoLiveOrCachedStateExists() {
        assertEquals("running", SessionStateRestorePolicy.previousState("running", "completed", "blocked"))
        assertEquals("completed", SessionStateRestorePolicy.previousState(null, "completed", "blocked"))
        assertEquals("blocked", SessionStateRestorePolicy.previousState(null, null, "blocked"))
    }

    @Test
    fun `old Windows goal result without command remains readable`() {
        val result = ProtocolJson.decodeFromString(
            GoalCommandResult.serializer(),
            """{"type":"goal_command_result","requestId":"r1","sessionId":"s1","ok":false,"message":"native channel offline"}""",
        )
        assertEquals("", result.command)
        assertEquals(false, result.ok)
        assertEquals("native channel offline", result.message)
    }

    @Test
    fun guidanceAlwaysIncludesItsMessageType() {
        val encoded = ProtocolJson.encodeToString(
            GuidanceMessage(requestId = "request-1", sessionId = "session-1", text = "继续", mode = "steer"),
        )
        val value = ProtocolJson.parseToJsonElement(encoded).jsonObject

        assertEquals("guidance", value.getValue("type").jsonPrimitive.content)
        assertEquals("steer", value.getValue("mode").jsonPrimitive.content)
    }

    @Test
    fun guidanceSerializesImageAttachmentsAtomically() {
        val encoded = ProtocolJson.encodeToString(
            GuidanceMessage(
                requestId = "request-image",
                sessionId = "session-1",
                text = "请看截图",
                mode = "steer",
                attachments = listOf(GuidanceAttachment("problem.jpg", "image/jpeg", 3, "AQID")),
            ),
        )
        val value = ProtocolJson.parseToJsonElement(encoded).jsonObject
        val attachment = value.getValue("attachments").jsonArray.single().jsonObject

        assertEquals("problem.jpg", attachment.getValue("name").jsonPrimitive.content)
        assertEquals("image/jpeg", attachment.getValue("mimeType").jsonPrimitive.content)
        assertEquals("3", attachment.getValue("sizeBytes").jsonPrimitive.content)
        assertEquals("AQID", attachment.getValue("dataBase64").jsonPrimitive.content)
    }

    @Test
    fun `last sent guidance preserves its device and session after process restart`() {
        val previous = LastSentGuidance(
            deviceId = "windows-device",
            sessionId = "session-1",
            text = "继续修复 Windows 通讯，不要停止当前任务。",
        )

        val restored = ProtocolJson.decodeFromString<LastSentGuidance>(
            ProtocolJson.encodeToString(previous),
        )

        assertEquals(previous, restored)
    }

    @Test
    fun clientInfoAlwaysIncludesRoutingFields() {
        val encoded = ProtocolJson.encodeToString(
            ClientInfoMessage(appVersion = "0.6.2", versionCode = 8),
        )
        val value = ProtocolJson.parseToJsonElement(encoded).jsonObject

        assertEquals("client_info", value.getValue("type").jsonPrimitive.content)
        assertEquals("android", value.getValue("platform").jsonPrimitive.content)
        assertEquals("7", value.getValue("statusProtocolVersion").jsonPrimitive.content)
    }

    @Test
    fun snapshotAcceptsOptionalEvidenceMetadataWithoutComputerPaths() {
        val snapshot = ProtocolJson.decodeFromString<WireSnapshot>(
            """{"type":"snapshot","machine":{"id":"m1","name":"Mac"},"sentAt":"now","sessions":[{"id":"s1","title":"页面","updatedAt":"now","state":"running","message":"已完成","evidence":[{"id":"0123456789abcdef0123456789abcdef","name":"result.png","mimeType":"image/png","downloadPath":"/evidence/0123456789abcdef0123456789abcdef"}]}]}""",
        )
        assertEquals("result.png", snapshot.sessions.single().evidence.single().name)
        assertEquals(false, ProtocolJson.encodeToString(snapshot).contains("/Users/"))
    }

    @Test
    fun activeGoalRemainsVisibleInTheDecodedMobileSnapshot() {
        val snapshot = ProtocolJson.decodeFromString<WireSnapshot>(
            """{"type":"snapshot","machine":{"id":"m1","name":"Mac"},"sentAt":"now","sessions":[{"id":"s1","title":"ai剪辑工作台开发","updatedAt":"now","state":"running","message":"继续制作","goal":{"status":"active","objective":"完成 300 秒短剧"}}]}""",
        )

        assertEquals("active", snapshot.sessions.single().goal?.status)
        assertEquals("完成 300 秒短剧", snapshot.sessions.single().goal?.objective)
        assertEquals("进行中", GoalPresentation.label(snapshot.sessions.single().goal!!.status))
        assertEquals(false, GoalPresentation.canResume("active", sessionRunning = true))
    }

    @Test
    fun deleteGoalCommandCarriesExplicitConfirmation() {
        val encoded = ProtocolJson.encodeToString(
            GoalCommandMessage(
                requestId = "goal-1",
                sessionId = "session-1",
                command = "delete",
                confirmed = true,
            ),
        )
        val value = ProtocolJson.parseToJsonElement(encoded).jsonObject
        assertEquals("goal_command", value.getValue("type").jsonPrimitive.content)
        assertEquals("delete", value.getValue("command").jsonPrimitive.content)
        assertEquals("true", value.getValue("confirmed").jsonPrimitive.content)
    }
}
