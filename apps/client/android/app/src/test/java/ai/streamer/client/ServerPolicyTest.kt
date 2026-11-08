package ai.streamer.client
import org.junit.Assert.*
import org.junit.Test
class ServerPolicyTest {
    @Test fun acceptsServerOriginsAndQrLinks() {
        assertEquals("https://home.local:8443", ServerPolicy.origin("https://home.local:8443/"))
        assertEquals(ConnectionInput("https://home.local:8443", "server-1"), ServerPolicy.connection("streamerai://connect?url=https%3A%2F%2Fhome.local%3A8443&serverId=server-1"))
    }
    @Test fun rejectsNativeSchemesAndEmbeddedCredentials() {
        for (value in listOf("file:///etc/passwd", "javascript:alert(1)", "https://user:secret@host", "https://host/#setup=secret", "https://host/path", "http://public.example", "http://fd.public.example", "http://10.a.1.1.1")) {
            try { ServerPolicy.origin(value); fail("Accepted unsafe address") } catch (_: Exception) { }
        }
        assertFalse(ServerPolicy.safeExternal("intent://open")); assertFalse(ServerPolicy.sameOrigin("https://other.local", "https://home.local"))
        assertTrue(ServerPolicy.sameOrigin("https://home.local/api/v1/profiles", "https://home.local"))
    }
}
