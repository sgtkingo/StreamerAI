package ai.streamer.client

import java.net.URI
import java.net.URLDecoder

data class ConnectionInput(val url: String, val serverId: String? = null)

object ServerPolicy {
    fun origin(input: String): String {
        require(input.length <= 4096) { "Server address is too long." }
        val uri = URI(input.trim())
        require(uri.scheme in listOf("https", "http") && !uri.host.isNullOrBlank() && uri.userInfo == null && uri.query == null && uri.fragment == null && (uri.path.isNullOrEmpty() || uri.path == "/")) { "Enter the server's HTTP or HTTPS address without a path or setup key." }
        require(uri.port == -1 || uri.port in 1..65535) { "Invalid server port." }
        val host = uri.host.lowercase().removePrefix("[").removeSuffix("]")
        val parts = host.split(".").mapNotNull { it.toIntOrNull() }
        val local = host == "localhost" || host == "::1" || host.endsWith(".local") || (!host.contains(".") && !host.contains(":")) || (host.contains(":") && (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:"))) || (Regex("[0-9]{1,3}(\\.[0-9]{1,3}){3}").matches(host) && parts.size == 4 && parts.all { it in 0..255 } && (parts[0] == 127 || parts[0] == 10 || (parts[0] == 192 && parts[1] == 168) || (parts[0] == 172 && parts[1] in 16..31) || (parts[0] == 169 && parts[1] == 254)))
        require(uri.scheme != "http" || local) { "Use HTTPS for a server outside your local network." }
        val port = if (uri.port == -1 || (uri.scheme == "https" && uri.port == 443) || (uri.scheme == "http" && uri.port == 80)) "" else ":${uri.port}"
        return "${uri.scheme.lowercase()}://${uri.host.lowercase()}$port"
    }
    fun connection(input: String): ConnectionInput {
        if (!input.startsWith("streamerai://")) return ConnectionInput(origin(input))
        val uri = URI(input)
        require(uri.host == "connect" && uri.userInfo == null) { "Invalid server QR link." }
        val query = (uri.rawQuery ?: "").split("&").associate { part -> val pieces = part.split("=", limit = 2); URLDecoder.decode(pieces[0], "UTF-8") to URLDecoder.decode(pieces.getOrElse(1) { "" }, "UTF-8") }
        val id = query["serverId"]
        require(id == null || Regex("[a-zA-Z0-9:_-]{1,160}").matches(id)) { "Invalid server identity." }
        return ConnectionInput(origin(query["url"] ?: ""), id)
    }
    fun sameOrigin(value: String, selected: String): Boolean = try {
        val uri = URI(value)
        origin("${uri.scheme}://${uri.rawAuthority}") == selected
    } catch (_: Exception) { false }
    fun safeExternal(value: String): Boolean = try { val uri = URI(value); value.length <= 4096 && uri.scheme == "https" && !uri.host.isNullOrBlank() && uri.userInfo == null } catch (_: Exception) { false }
}
