package ai.streamer.client

import android.content.Context
import android.net.wifi.WifiManager
import org.json.JSONObject
import java.net.DatagramPacket
import java.net.InetAddress
import java.net.MulticastSocket
import java.net.NetworkInterface
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL
import java.util.UUID

data class HomeServer(val serverId: String, val householdId: String?, val name: String, val url: String) {
    fun json(): String = JSONObject().put("serverId", serverId).put("householdId", householdId ?: JSONObject.NULL).put("name", name).put("url", url).toString()
    companion object {
        fun parse(value: JSONObject, expectedNonce: String? = null): HomeServer {
            require(value.getString("protocol") == "streamerai-discovery" && value.getInt("version") == 1) { "This is not a StreamerAI server." }
            require(expectedNonce == null || value.optString("nonce") == expectedNonce) { "Invalid discovery response." }
            val id = value.getString("serverId"); val name = value.getString("name")
            require(id.isNotBlank() && id.length <= 160 && name.isNotBlank() && name.length <= 120) { "Invalid server identity." }
            return HomeServer(id, if (value.isNull("householdId")) null else value.getString("householdId"), name, ServerPolicy.origin(value.getString("url")))
        }
        fun saved(value: String): HomeServer { val json = JSONObject(value); return HomeServer(json.getString("serverId"), if (json.isNull("householdId")) null else json.getString("householdId"), json.getString("name"), ServerPolicy.origin(json.getString("url"))) }
    }
}

object Discovery {
    fun find(context: Context): List<HomeServer> {
        val manager = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
        val lock = manager?.createMulticastLock("streamerai-discovery")?.apply { setReferenceCounted(false); acquire() }
        try {
            MulticastSocket(0).use { socket ->
                socket.broadcast = true; socket.timeToLive = 1; socket.soTimeout = 250
                val nonce = UUID.randomUUID().toString()
                val data = JSONObject().put("protocol", "streamerai-discovery").put("version", 1).put("type", "discover").put("nonce", nonce).toString().toByteArray(Charsets.UTF_8)
                val targets = mutableSetOf("239.255.77.77", "255.255.255.255")
                NetworkInterface.getNetworkInterfaces().toList().filter { it.isUp && !it.isLoopback }.forEach { network -> network.interfaceAddresses.mapNotNull { it.broadcast?.hostAddress }.forEach { targets.add(it) } }
                fun send() { targets.forEach { target -> try { socket.send(DatagramPacket(data, data.size, InetAddress.getByName(target), 47777)) } catch (_: Exception) { } } }
                send(); val started = System.nanoTime(); val found = linkedMapOf<String, HomeServer>(); var retried = false
                while ((System.nanoTime() - started) / 1_000_000 < 2000 && !Thread.currentThread().isInterrupted) {
                    if (!retried && (System.nanoTime() - started) / 1_000_000 > 900) { send(); retried = true }
                    val packet = DatagramPacket(ByteArray(4097), 4097)
                    try { socket.receive(packet); if (packet.length <= 4096) { val server = HomeServer.parse(JSONObject(String(packet.data, 0, packet.length, Charsets.UTF_8)), nonce); found[server.serverId + server.url] = server } } catch (_: SocketTimeoutException) { } catch (_: Exception) { }
                }
                return found.values.sortedBy { it.name }
            }
        } finally { if (lock?.isHeld == true) lock.release() }
    }
    fun verify(input: ConnectionInput): HomeServer {
        val connection = URL(input.url + "/api/v1/installation/discovery").openConnection() as HttpURLConnection
        connection.connectTimeout = 5000; connection.readTimeout = 5000; connection.instanceFollowRedirects = false
        connection.setRequestProperty("Accept", "application/json")
        try {
            require(connection.responseCode == 200) { "The server cannot be reached. Check its address and network." }
            val bytes = connection.inputStream.use { stream ->
                val output = java.io.ByteArrayOutputStream()
                val chunk = ByteArray(1024)
                while (output.size() <= 4096) { val count = stream.read(chunk, 0, minOf(chunk.size, 4097 - output.size())); if (count < 0) break; output.write(chunk, 0, count) }
                output.toByteArray()
            }
            require(bytes.size <= 4096) { "Invalid server response." }
            val server = HomeServer.parse(JSONObject(String(bytes, Charsets.UTF_8)))
            require(input.serverId == null || input.serverId == server.serverId) { "The server identity changed. Choose the server again before pairing." }
            return server.copy(url = input.url)
        } finally { connection.disconnect() }
    }
}
