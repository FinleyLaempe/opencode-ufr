# Fortinet SSL-VPN (fortisslvpn) Wire Protocol Specification

Implementation-ready protocol reference for a from-scratch TypeScript client
(userspace TCP tunnel over TLS, no TUN device). Derived from openconnect's
implementation (`fortinet.c`, `ppp.c`, `ppp.h`, `mainloop.c`) and cross-checked
against openfortivpn (`io.c`, `http.c`, `tunnel.c`, `main.c`). Exact line
references are listed under [Source references](#source-references).

The protocol has three phases, all on the same TCP/TLS connection to the
FortiGate's SSL-VPN port (default 443, configurable):

1. **HTTP authentication** → obtain the `SVPNCOOKIE` session cookie.
2. **HTTP configuration** → fetch XML with assigned IPs, DNS, split-tunnel routes.
3. **Tunnel mode** → the TLS connection stops speaking HTTP and carries
   length-prefixed **PPP over TCP** frames. There is no TUN device required:
   the client implements the PPP/IPv4 layer directly in userspace.

All multi-byte integers in the tunnel framing are **big-endian**.

---

## 1. Authentication flow

### 1.1 Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/` (or any path) | GET | Initial hit; redirects (HTTP 302 **or JS-only**) to `/remote/login` |
| `/remote/login` | GET | Login HTML page. If a non-default realm is configured, the redirect target is `/remote/login?realm=<realm>` — capture the `realm` query parameter |
| `/remote/logincheck` | POST | Submits credentials; returns `Set-Cookie: SVPNCOOKIE=...` on success, or a 2FA challenge |
| `/remote/info` | GET | (Not used by openconnect/openfortivpn auth) portal info XML listing realms/auth methods; optional |
| `/remote/logout` | GET | Kills the session (see §5.3) |
| `/remote/fortisslvpn_xml` | GET | Tunnel config XML (see §2.1) |
| `/remote/fortisslvpn` | GET | Legacy (FortiOS 4) HTML config; obsolete |
| `/remote/sslvpn-tunnel` | GET | Switches the connection into tunnel mode (see §2.2) |

### 1.2 Step-by-step

1. **GET** the portal root. The server normally redirects to `/remote/login`.
   **FortiOS 7.4+ quirk:** the redirect may be JavaScript-only, with HTTP 200
   and a body like:
   ```html
   <html><script type="text/javascript">
   if (window!=top) top.location=window.location;top.location="/remote/login";
   </script></html>
   ```
   Scan the body for `top.location="<path>"` and treat it as a redirect
   (openconnect does this before any HTML parsing, `fortinet.c:118-140`).
   If the redirect URL carries `?realm=<name>`, save it (URL-escaped) — it must
   be echoed back in the login POST.

2. **POST /remote/logincheck** with
   `Content-Type: application/x-www-form-urlencoded` and body:

   ```
   username=<url-enc>&credential=<url-enc>&realm=<url-enc>&ajax=1&just_logged_in=1
   ```

   - `username` — login name
   - `credential` — password (the field is literally named `credential`, not `password`)
   - `realm` — the auth realm captured in step 1; may be empty (`&realm=`)
   - `ajax=1` — required: makes the server answer with a plain-text `ret=...` body
     instead of an HTML page
   - `just_logged_in=1` — sent by openconnect; openfortivpn also sends
     `redir=%2Fremote%2Findex` — both variants are accepted

   **HTTP status quirks (deliberate, do not "fix"):**
   - A **failed login** (wrong user/pass) returns **HTTP 405 Method Not Allowed**,
     not 401/403. Treat 405 as "invalid credentials, retry".
   - An **HTTP 401** with an HTML body is *not* HTTP auth — it is an HTML-form
     2FA challenge (see §1.5). Disable HTTP Basic/Digest handling entirely.

3. **Success detection:** the 200 response contains a `Set-Cookie: SVPNCOOKIE=<value>`
   header. The session cookie is exactly this one cookie. Store the raw value
   and send `Cookie: SVPNCOOKIE=<value>` on every subsequent request
   (`/remote/fortisslvpn_xml`, `/remote/sslvpn-tunnel`, `/remote/logout`).
   openconnect reduces its cookie to just `SVPNCOOKIE=<value>`
   (`fortinet.c:242-251`); openfortivpn likewise extracts `SVPNCOOKIE=` from the
   `Set-Cookie:` line, terminating at `;` or CR/LF. The value may contain
   characters such as `%2F` — send it verbatim, no re-encoding.

### 1.3 User-Agent

- openconnect sends **`Mozilla/5.0 SV1`** as the User-Agent for Fortinet
  requests (it swaps this in for the tunnel-connect request in
  `fortinet_common_headers()`; this is exactly what openfortivpen uses).
- openfortivpn defaults to `Mozilla/5.0 SV1` for *all* requests (`main.c:691`)
  and additionally sends, even on GETs:
  `Accept: */*`, `Accept-Encoding: identity`, `Pragma: no-cache`,
  `Cache-Control: no-store, no-cache, must-revalidate`,
  `If-Modified-Since: Sat, 1 Jan 2000 00:00:00 GMT`,
  `Content-Type: application/x-www-form-urlencoded`, `Content-Length: 0`.
  openconnect notes these are **not** required (`fortinet.c:55-67`); a minimal
  client can send just `Host`, `User-Agent`, and `Cookie`.
- `Host:` is the real gateway hostname (with `:port` when not 443).
  openfortivpn sends `Host: sslvpn` on the tunnel request; openconnect
  explicitly notes this is unnecessary and can *break* vhost-based Fortinet
  servers (`fortinet.c:790-794`). Use the real hostname.

### 1.4 `ret=` response codes

When `ajax=1` is used, the success/failure body is a comma/`&`-separated
key=value list beginning with `ret=` (parse by splitting on `[&,\r\n]`):

| `ret` | Meaning |
|---|---|
| `0` | Authentication failed |
| `1` | Authentication succeeded |
| `6` | Server replied with an unsupported challenge type |
| other | Unknown; log and continue |

A 200 response whose body contains `tokeninfo=` (and no SVPNCOOKIE) means a
**2FA challenge** — see §1.5.

### 1.5 Two-factor / OTP handling

Two distinct 2FA mechanisms exist:

**A. `tokeninfo`-type challenge (plain-text, `ajax=1` style)**

The 200 body looks like:

```
ret=<n>,reqid=<reqid>,polid=<polid>,grp=<grp>,portal=<portal>,peer=<peer>,magic=<magic>[,chal_msg=<text>]
```

- If `tokeninfo=ftm_push`, the server supports FortiToken Mobile **push**.
- The client must prompt for a one-time code, then POST a **second**
  `/remote/logincheck` request that parrots the challenge values back:

  ```
  username=<url-enc>&code=<otp>&realm=<url-enc>&reqid=<reqid>&polid=<polid>&grp=<grp>&portal=<portal>&peer=<peer>&magic=<magic>
  ```

  - openfortivpn's exact order: `username, realm, reqid, polid, grp, portal,
    peer, code=<otp>&code2=&magic=<magic>`.
  - openconnect's order: form fields (`username`, `code`), then `&realm=`,
    then the parroted `reqid,polid,grp,portal,peer,magic` fields in that order;
    **`magic` must be last** so it can do the FTM-push trick below.
  - **FTM push:** if `tokeninfo=ftm_push` and the user left the code blank,
    strip the `&magic=...` parameter and append `&ftmpush=1` instead — this
    triggers a mobile push notification instead of waiting for a tokencode
    (`fortinet.c:223-228`). The request is then repeated (after a user-set
    delay) until it yields SVPNCOOKIE.
  - `chal_msg=` (if present) is the human-readable prompt to show.

**B. HTML-form challenge (HTTP 401)**

The 401 response body contains a normal HTML `<form>` with hidden fields —
`username`, `magic`, `reqid`, `grpid`, etc. — and a password-ish field named
`credential`. Parse the form, re-render it to the user (the `credential` field
collects the OTP), and POST it back to the *form's action URL* (usually
`/remote/logincheck` again). openconnect parses this with an HTML parser
(`fortinet.c:296-325`); a minimal client can find the `<form>` element and
enumerate `<input>` name/value pairs, replacing the value of the OTP entry
field.

After either 2FA round-trip, loop back to the SVPNCOOKIE check: repeat POSTs
(until success/limit) — each response is either a new challenge or the cookie.

**SAML** exists too (openfortivpn `GET /remote/saml/auth_id?id=<session_id>`),
out of scope for a first implementation.

---

## 2. Tunnel establishment

### 2.1 Configuration fetch

With the cookie, **GET /remote/fortisslvpn_xml?dual_stack=1**
(`dual_stack=1` omitted when IPv6 is disabled). Returns an XML document:

```xml
<?xml version="1.0" encoding="utf-8"?>
<sslvpn-tunnel ver="2" dtls="1" patch="1">
  <dtls-config heartbeat-interval="10" heartbeat-fail-count="10"
               heartbeat-idle-timeout="10" client-hello-timeout="10"/>
  <tunnel-method value="ppp"/>
  <tunnel-method value="tun"/>
  <fos platform="FG100E" major="5" minor="06" patch="6" build="1630" branch="1630"/>
  <auth-ses check-src-ip='1' tun-connect-without-reauth='1' tun-user-ses-timeout='240' />
  <client-config save-password="off" keep-alive="on" auto-connect="off"/>
  <ipv4>
    <dns ip="1.1.1.1"/>
    <dns ip="8.8.8.8" domain="foo.com"/>
    <split-dns domains='mydomain1.local,mydomain2.local'
               dnsserver1='10.10.10.10' dnsserver2='10.10.10.11' />
    <assigned-addr ipv4="172.16.1.1"/>
    <split-tunnel-info>
      <addr ip="10.11.10.10" mask="255.255.255.255"/>
      <addr ip="10.11.1.0" mask="255.255.255.0"/>
    </split-tunnel-info>
    <split-tunnel-info negate="1">
      <addr ip="1.2.3.4" mask="255.255.255.255"/>
    </split-tunnel-info>
  </ipv4>
  <ipv6>
    <assigned-addr ipv6='fdff:ffff::1' prefix-len='120'/>
    <split-tunnel-info>
      <addr ipv6='fdff:ffff::' prefix-len='120'/>
    </split-tunnel-info>
  </ipv6>
  <idle-timeout val="3600"/>
  <auth-timeout val="18000"/>
</sslvpn-tunnel>
```

Semantics (verbatim from the openconnect example, `fortinet.c:392-426`):

- Root element must be `sslvpn-tunnel`; attribute `dtls="1"` ⇒ DTLS is
  available on the **same UDP port** as TLS (openconnect: `udp_sockaddr(vpninfo,
  vpninfo->port)`).
- `dtls-config/@heartbeat-interval` ⇒ DPD interval in **seconds** for both the
  DTLS and the TCP channel (see §5.1).
- `tunnel-method value="ppp"` ⇒ the tunnel carries PPP (what we implement).
  `value="tun"` is a raw-IP mode not used by openconnect.
- `auth-ses`:
  - `tun-connect-without-reauth="1"` ⇒ the server permits reconnecting after a
    dropped connection **without** re-running HTTP auth (see §5.4);
  - `check-src-ip="1"` ⇒ reconnect only from the same source IP;
  - `tun-user-ses-timeout="240"` ⇒ seconds the dropped session is retained.
- `<fos>` ⇒ server version info (informational).
- `ipv4/assigned-addr/@ipv4` ⇒ **your inner IPv4 address**.
- `ipv4/dns[@ip]` ⇒ DNS servers (up to 3 parsed); `@domain` ⇒ search domain.
- `ipv4/split-dns` ⇒ split-DNS domains/servers (openconnect parses but does
  not implement it).
- `ipv4/split-tunnel-info` ⇒ split-tunnel routes; each `<addr ip= mask=>` is an
  include route; a `<split-tunnel-info negate="1">` block lists **exclude**
  routes. IPv6 analogues use `<addr ipv6= prefix-len=>` under `<ipv6>`.
- `idle-timeout/@val`, `auth-timeout/@val` ⇒ idle timeout (seconds, e.g. 3600)
  and overall auth-session lifetime (e.g. 18000 s).

**If the GET fails or redirects to `/remote/login`, the cookie/session is dead**
(a redirect to `/remote/login` on this request specifically indicates session
invalidation on older FortiOS). On `-EPERM` openconnect retries the legacy
`GET /remote/fortisslvpn` only to distinguish "ancient server" from "session
rejected". Note openconnect's own warning (`fortinet.c:652-662`): on
**reconnect**, re-issuing this request can *invalidate the cookie* — a
reconnect must re-run only PPP negotiation, not this fetch (§5.4).

### 2.2 Opening the SSL data channel

The data channel is a **new (or reused) TLS connection to the same port 443** —
no second port, no HTTP CONNECT, no magic pre-HTTP bytes. The client:

1. Opens a TLS connection (openconnect reuses the existing HTTPS connection;
   openfortivpn closes and reopens first — openconnect notes neither is
   necessary, `fortinet.c:790-794`).
2. Sends, in the clear over TLS:

   ```
   GET /remote/sslvpn-tunnel HTTP/1.1\r\n
   Host: <host>[:<port>]\r\n
   User-Agent: Mozilla/5.0 SV1\r\n
   Cookie: SVPNCOOKIE=<value>\r\n
   \r\n
   ```

3. **On success the server sends no HTTP response at all** — it immediately
   starts emitting tunnel frames (§3). openconnect's comment: *"If this
   connection request succeeds, no HTTP response appears. We just start
   sending our encapsulated PPP configuration packets. However, if the request
   FAILS, it WILL send an HTTP response. ... Don't blame me. I didn't design
   this."* (`fortinet.c:808-815`).
4. The client therefore **peeks at the first bytes** of the response stream: if
   they are `HTTP/` (per `check_http_status()`, `ppp.c:1047-1056`), parse the
   status — a `403 Forbidden` means the portal does not allow tunnel mode for
   this account/realm (openfortivpn `io.c:460-468`); any 4xx ⇒ auth/permission
   failure; treat tunnel establishment as failed. Otherwise the bytes are the
   first tunnel frame(s) (possibly spanning/prefixed by more data).

The tunnel frames then flow bidirectionally over this single TLS connection.

### 2.3 DTLS data channel (optional)

If the XML advertises `dtls="1"`, a **DTLS 1.2** session over UDP on the same
port can be used after TLS is up. The handshake is bespoke (not DTLS
application data conventions):

- Client hello: `be16 length | "GFtype\0clthello\0SVPNCOOKIE\0" | <cookie value> | 0x00`
  where `length` counts **itself** (`2 + 27 + strlen(cookie) + 1`).
- Server hello: `be16 length | "GFtype\0svrhello\0handshake\0" | "ok\0"`
  (`length = 2 + 26 + 3 = 31`), i.e. bytes `00 1F 47 46 74 79 70 65 00 73 76 72 ... 68 61 6E 64 73 68 61 6B 65 00 6F 6B 00`.
- Resend the hello every 1 s; give up after ~5 s and fall back to TCP
  (`ppp.c:1726-1741`). If PPP frames arrive before the `ok`, treat that as
  success too (`fortinet.c:864-869`).

A TCP-only TypeScript client can ignore DTLS entirely.

---

## 3. Packet framing over the tunnel (Fortinet encapsulation)

Every frame on the TLS connection (both directions) has a fixed **6-byte
header** followed by one **complete PPP frame** (no HDLC, no FCS):

```
offset  size  field
0       2     total_len  (be16) = 6 + ppp_len
2       2     magic      (be16) = 0x5050  ("PP")
4       2     ppp_len    (be16) = length of the PPP frame that follows
6       ...   PPP frame (ppp_len bytes)
```

Validation (receive): `magic == 0x5050` **and** `total_len - 6 == ppp_len`
(openconnect `ppp.c:1188-1197`; openfortivpn additionally requires
`total_len >= 7`, i.e. `ppp_len >= 1`).

Example — LCP Configure-Request with MRU option, wrapped:

```
PPP frame:  FF 03 C0 21 01 01 00 0A  01 04 05 46 05 04 11 22 33 44   (18 bytes)
Wrapped:    00 18 50 50 00 12  FF 03 C0 21 01 01 00 0A  01 04 05 46 05 04 11 22 33 44
            └─26─┘ └0x5050┘ └─24─┘ └────── PPP frame (24 bytes) ──────┘
```

Receive-side rules:

- **Concatenation:** one TLS record may contain several back-to-back frames;
  after consuming a frame, immediately parse the next from the remaining bytes
  (`next_len` handling, `ppp.c:1327-1340`).
- **Splitting:** a frame may span TLS records — if fewer than
  `6 + ppp_len` bytes are available, buffer them until complete
  (`partial_rec_size`, `ppp.c:1169-1185`).
- **Oversized frames:** the server may send frames larger than the negotiated
  MTU; allocate a receive buffer of at least 16384 bytes (`ppp.c:1079-1083`).
- If the first bytes of the connection are `HTTP/...` instead of a frame, this
  is the failure path of §2.2.

Send-side: build the PPP frame, then prepend the 6-byte header
(`ppp.c:1480-1486`). Multiple small PPP frames each get their own header;
openconnect does not coalesce.

**There are no separate tunnel-level control packet types** (unlike
GlobalProtect's `AC_PKT_*`): all keepalive/DPD/terminate signalling is done
inside PPP/LCP (§4.3, §5).

---

## 4. PPP layer

Yes — fortisslvpn runs **plain PPP over the SSL channel** (RFC 1661 framing,
*not* HDLC-encoded for Fortinet). openconnect's encapsulation constant:
`PPP_ENCAP_FORTINET = 5`, `encap_len = 6` (`openconnect-internal.h:267`,
`ppp.c:269-273`).

### 4.1 PPP frame layout

Each PPP frame inside the tunnel header:

```
offset size  field
0      1     Address  = 0xFF      (optional — see below)
1      1     Control  = 0x03      (optional)
2      1-2   Protocol field (be16 when first byte is even, else 1 byte)
...          Information (payload)
```

- The `FF 03` address/control pair is **optional in both directions**; a
  receiver must detect it by checking `data[0]==0xFF && data[1]==0x03` and skip
  it (`ppp.c:1237-1240`). openconnect *sends* `FF 03` on every frame for the
  Fortinet encapsulation because it never negotiates ACCOMP with Fortinet
  (`add_ppp_header`, `ppp.c:1033-1045`; `ppp_reset` strips `BIT_ACCOMP`/
  `BIT_PFCOMP` because **the Fortinet server rejects header compression**,
  `ppp.c:270-271`).
- Protocol field: normally 2 bytes big-endian. If the first byte is odd, the
  protocol is 1 byte (this only occurs if PFC was negotiated — don't offer it,
  but *parse* it defensively).

Protocol constants (`ppp.h:22-27`):

| Constant | Value | Meaning |
|---|---|---|
| `PPP_LCP` | `0xC021` | Link Control Protocol |
| `PPP_IPCP` | `0x8021` | IPv4 Control Protocol |
| `PPP_IP6CP` | `0x8057` | IPv6 Control Protocol |
| `PPP_CCP` | `0x80FD` | Compression (reject it) |
| `PPP_IP` | `0x0021` | IPv4 data packet |
| `PPP_IP6` | `0x0057` | IPv6 data packet |

### 4.2 NCP/LCP packet format (RFC 1661 §3.2-ish)

All LCP/IPCP/IP6CP packets share a 4-byte header:

```
offset size  field
0      1     Code
1      1     Identifier
2      2     Length (be16) — includes this 4-byte header
4      ...   Options: TLV, each = tag(1) + len(1) + data; len includes the 2 header bytes
```

Code constants (`ppp.h:30-41`):

| Code | Name |
|---|---|
| 1 | `CONFREQ` (Configure-Request) |
| 2 | `CONFACK` (Configure-Ack) |
| 3 | `CONFNAK` (Configure-Nak) |
| 4 | `CONFREJ` (Configure-Reject) |
| 5 | `TERMREQ` (Terminate-Request) |
| 6 | `TERMACK` (Terminate-Ack) |
| 7 | `CODEREJ` (Code-Reject) |
| 8 | `PROTREJ` (Protocol-Reject) |
| 9 | `ECHOREQ` (Echo-Request) |
| 10 | `ECHOREP` (Echo-Reply) |
| 11 | `DISCREQ` (Discard-Request) |

Validate `Length` against the actual frame size; if it is shorter than the
frame, the trailing bytes are junk (ignore); if longer, the frame was split
(`ppp.c:783-791`).

### 4.3 LCP negotiation

**Client CONFREQ** (openconnect's options, `ppp.c:557-591`):

| Tag | Name | Length | Value |
|---|---|---|---|
| 1 | `LCP_MRU` | 4 | be16 MRU (client's calculated MTU; see below) |
| 5 | `LCP_MAGIC` | 6 | 4-byte random magic number |

openconnect does **not** offer `LCP_ASYNCMAP` (2), `LCP_PFCOMP` (7) or
`LCP_ACCOMP` (8) to Fortinet servers — *"Fortinet server rejects asyncmap and
header compression"* (`ppp.c:270-271`). Suggested client CONFREQ:

```
FF 03 C0 21 01 <id> 00 14  01 04 <MRU be16>  05 04 <magic be32>
```

**Server CONFREQ handling** (`ppp.c:379-541`): the server's request typically
carries `LCP_MRU`, optionally `LCP_ASYNCMAP` (4-byte be32 mask) and
`LCP_MAGIC`. Respond:

- **MRU:** openconnect "coaxes" — if the server's MRU is smaller than the
  client's MTU, it sends **one** `CONFNAK` echoing the option with *its own*
  larger MTU; on the next CONFREQ it accepts whatever the server sends and
  adopts it as the link MTU (`ppp.c:399-417`, `BIT_MRU_COAX`).
- **ASYNCMAP:** record it (`in_asyncmap`); irrelevant without HDLC.
- **MAGIC:** record it; used in Echo replies.
- Unknown options → include verbatim in a `CONFREJ`; Van-Jacobson compression
  (`IPCP`-style tag 2 in LCP context, protocol 0x002d) → `CONFREJ`.
- If nothing needs rejecting/naking → `CONFACK` with the request's options
  echoed verbatim.

Retry: if no CONFACK for our CONFREQ within **3 s**, retransmit with a new id
(`ppp.c:891-901`). LCP is established when we have both
`NCP_CONF_ACK_SENT` and `NCP_CONF_ACK_RECEIVED` (state `PPPS_OPENED`).

**Echo handling:** on `ECHOREQ` (only when LCP is OPENED), reply `ECHOREP`
with the same identifier and a 4-byte payload containing *our* magic number
(`ppp.c:807-810`). Incoming `ECHOREP`/`DISCREQ` are ignored.

**Protocol-Reject:** if we receive `PROTREJ` (code 8) from the server naming
`0x8021`/`0x8057`, that protocol family (IPv4/IPv6) is disabled
(`ppp.c:841-854`). Conversely, if the peer sends us a protocol we don't
support (e.g. CCP), reply LCP `PROTREJ` with the 2-byte protocol field plus
the rejected packet (truncated to MRU-10).

### 4.4 No PAP/CHAP

There is **no PPP-level authentication**. The `PPPS_AUTHENTICATE` state is
never used ("XX: should never", `ppp.c:1012`); user authentication happened at
the HTTP layer via SVPNCOOKIE. LCP goes straight from ESTABLISH to OPENED.

### 4.5 IPCP negotiation (inner IPv4 + DNS)

After LCP opens, the client sends an IPCP `CONFREQ` (`ppp.c:593-603`):

```
FF 03 80 21 01 <id> <len>  03 04 <our-IPv4 or 0.0.0.0>
                           81 04 00 00 00 00   (DNS1, tag 129)
                           83 04 00 00 00 00   (DNS2, tag 131)
                           82 04 00 00 00 00   (NBNS1, tag 130)
                           84 04 00 00 00 00   (NBNS2, tag 132)
```

- Tag 3 = `IPCP_IPADDR` (RFC 1332); sent as **0.0.0.0** to solicit an address.
- Tags 129-132 = `IPCP_xNS_BASE + n` (RFC 1877): DNS1=129, NBNS1=130,
  DNS2=131, NBNS2=132; sent as 0.0.0.0 to solicit.
- If the XML config already supplied DNS servers, the client omits the DNS
  solicitations.

The server answers with `CONFNAK` (never `CONFACK` for zero values) carrying
the **assigned inner IPv4 address** and **DNS/NBNS servers** in the
corresponding options (`ppp.c:692-735`). The client then re-sends its CONFREQ
with the nak-offered values, which the server ACKs. (openconnect's mapping
note at `ppp.c:950-961`: nameserver slots are `nameservers[t & 3]`.)

This IPCP address is the *authoritative* inner IPv4 for the session — it is
the same address the XML `<assigned-addr>` advertises, but negotiate it anyway
(openconnect requires `NCP_CONF_ACK_SENT|RECEIVED` for both before entering
`PPPS_NETWORK`). Retry every 3 s, same as LCP.

**IP6CP** (RFC 5072), if IPv6: one option, tag 1 `IP6CP_INT_ID`, 8-byte
interface identifier (the low 8 bytes of a link-local address). Same
REQ→NAK→REQ→ACK dance; the assigned interface identifier is then used with
`fe80::` prefix. Servers that don't do IPv6 may `PROTREJ` it — then IPv6 is
off.

**State machine** (`ppp.c:871-1031`):

```
DEAD → ESTABLISH → (LCP ack'd both ways) → OPENED
     → (IPCP ack'd both ways) → NETWORK   [data may flow]
     → TERMINATE → close
```

---

## 5. Keepalives, DPD, and teardown

### 5.1 Intervals

- The **only** configured keepalive value for the TCP channel is the XML
  `dtls-config/@heartbeat-interval` (seconds; example value 10). openconnect
  assigns it to both `ssl_times.dpd` and `dtls_times.dpd`
  (`fortinet.c:473-476`). If absent, there is no DPD and the client relies on
  TCP errors.
- There is **no separate periodic keepalive frame** for Fortinet (openconnect's
  `ssl_times.keepalive` stays 0; the LCP `DISCREQ`-as-keepalive path at
  `ppp.c:1415-1423` is for other protocols).
- DPD algorithm (`mainloop.c:454-497`):
  - If **no packet received** for `dpd` seconds → send **LCP Echo-Request**
    (code 9, id = next LCP id, 4-byte payload = our magic).
  - While an Echo is outstanding, re-send only after `dpd/2` more seconds.
  - If **no packet received** for `2 * dpd` seconds → peer dead → reconnect
    (§5.4) or exit.
  - Any received frame (including IP data) resets the timer — Echo replies are
    not required to be ACKed separately.

Example Echo-Request on the wire:

```
00 12 50 50 00 0C  FF 03 C0 21 09 <id> 00 08 <magic be32>
```

### 5.2 Server-initiated termination

- PPP `TERMREQ` (code 5, any NCP): reply `TERMACK` (same id, empty payload),
  record the reason string from the payload, and shut down
  (`ppp.c:812-830`). The payload text is printable, e.g. the admin message.
- Server closing the TLS socket is obviously also a teardown trigger.

### 5.3 Client-initiated teardown

1. (Clean PPP path, `ppp.c:963-1009`): send LCP `TERMREQ` (code 5, empty
   payload) with a fresh id; wait up to **1 s** for `TERMACK` on TLS (retries
   are a DTLS-only concern; one shot over TLS is fine). openconnect itself
   skips this on logout (`fortinet.c:880-882` "XX: handle clean PPP
   termination?") — it is safe but optional.
2. Close the TLS tunnel connection.
3. Open a **fresh** TLS connection and `GET /remote/logout` with the usual
   headers + `Cookie: SVPNCOOKIE=...` (`fortinet.c:874-901`). A 2xx means
   logged out; the server also invalidates the cookie.

### 5.4 Session timeouts and reconnect

- `auth-timeout` (XML, seconds): overall session validity; re-auth after it.
- `idle-timeout` (XML, seconds): server may drop an idle session.
- `auth-ses/tun-user-ses-timeout` (seconds): grace period for reconnecting
  after a dropped connection, **only if** `tun-connect-without-reauth="1"`;
  if `check-src-ip="1"`, also only from the same source IP. If the attribute
  is absent or `0`, a dead peer means full re-authentication.
- **Reconnect procedure** (critical quirk, `fortinet.c:652-662`): do **not**
  re-`GET /remote/fortisslvpn_xml` on reconnect — re-issuing it can invalidate
  the cookie/session. Just re-open TLS, re-send `GET /remote/sslvpn-tunnel`,
  and re-run the full PPP/ILCP/IPCP negotiation from `PPPS_DEAD`; expect to be
  assigned the same inner IP.
- Many FortiOS builds simply do not survive reconnect; treat reconnect failure
  as "re-authenticate from scratch".

---

## 6. What the server assigns, and where

| Item | Where delivered | Notes |
|---|---|---|
| Inner IPv4 | XML `<ipv4><assigned-addr ipv4=...>` **and** IPCP CONFNAK (tag 3) | IPCP is authoritative; they should agree |
| Inner IPv6 | XML `<ipv6><assigned-addr ipv6= prefix-len=>` and IP6CP interface-ID | IP6CP gives only the interface identifier (link-local); global address comes from XML |
| DNS servers | XML `<ipv4><dns ip=...>` and/or IPCP CONFNAK tags 129/131 (RFC 1877); NBNS 130/132 | up to ~3 parsed; solicited with zero values if not in XML |
| Search domains | XML `<dns domain=...>` | space-joined into one search list by openconnect |
| Split-DNS | XML `<split-dns domains=... dnsserver1=...>` | not implemented by openconnect |
| Split-tunnel include routes | XML `<split-tunnel-info><addr ip= mask=>` (or `ipv6=`/`prefix-len=`) | if none, default route (0.0.0.0/0) is implied |
| Split-tunnel exclude routes | XML `<split-tunnel-info negate="1"><addr ...>` | |
| MTU | LCP CONFREQ (server's MRU) / our nak-coaxing | not in the XML |
| DPD interval | XML `dtls-config/@heartbeat-interval` | |
| Idle/auth timeouts | XML `idle-timeout/@val`, `auth-timeout/@val`, `auth-ses/@tun-user-ses-timeout` | |

---

## 7. Quirks and server-bug workarounds

1. **405 = bad credentials.** Fortinet returns `405 Method Not Allowed` for
   failed logins and reserves `401` for HTML-form 2FA challenges. Never enable
   standard HTTP auth handling on `/remote/logincheck` (`fortinet.c:234-236`,
   `326-330`).
2. **JS-only redirects.** FortiOS 7.4+ redirects `/` → `/remote/login` purely
   via `top.location="..."` JS with HTTP 200; no `Location` header
   (`fortinet.c:118-140`).
3. **No HTTP response on tunnel success.** `GET /remote/sslvpn-tunnel` is
   answered with silence + PPP frames on success, and an HTTP error (e.g. 403)
   only on failure. Peek for `HTTP/` prefix (`ppp.c:1047-1056`,
   `fortinet.c:808-815`).
4. **Don't offer PFC/ACCOMP/ASYNCMAP** in LCP — Fortinet rejects header
   compression; openconnect strips those options for this encapsulation
   (`ppp.c:269-273`).
5. **MRU coaxing:** server offers a small MRU; nak once with your larger MTU,
   then accept the server's final value. Frames larger than the negotiated MTU
   can still arrive — use a ≥16 KiB receive buffer (`ppp.c:1079-1083`).
6. **Frame concatenation and splitting** across TLS records must both be
   handled (§3).
7. **Reconnect must not re-fetch the config.** Re-running
   `/remote/fortisslvpn_xml` after a drop can invalidate the session; redo only
   PPP negotiation (`fortinet.c:652-662`, issues #235/#297/#298).
8. **`Host: sslvpn` is not needed** (openfortivpn sends it) and may break
   vhost-hosted portals; use the real hostname, and reusing the auth TLS
   connection for the tunnel is fine (`fortinet.c:790-794`).
9. **DTLS `ok` may be lost**; if PPP frames arrive before `svrhello...ok`,
   treat DTLS as established (`fortinet.c:864-869`).
10. **IP6CP interface-ID from the server is garbage** on some builds (unusable
    for pinging); rely on XML-assigned addresses (`ppp.c:465-477`).
11. **Cookie handling:** only `SVPNCOOKIE` matters; pass its value through
    verbatim. `remote/fortisslvpn_xml` returning a redirect to
    `/remote/login` = session dead. `remote/logout` requires a **new** TLS
    connection (the old one is in tunnel mode).
12. **`ajax=1`** changes `/remote/logincheck` responses from HTML to the
    `ret=...` plain-text format; the 2FA parsing depends on it.
13. **No PPP auth, no CCP.** Reject `PPP_CCP` (0x80FD) with LCP PROTREJ if the
    server offers it; ignore Van-Jacobson compression offers.
14. **Termination:** a server LCP TERMREQ may arrive for any NCP (LCP/IPCP);
    ACK it (same id) and tear down; the payload is a human-readable reason.

---

## 8. Reference message flow (happy path)

```
C→S  GET  /                                        (HTTP, TLS #1)
S→C  302 Location: /remote/login[?realm=X]  or 200 + top.location JS
C→S  POST /remote/logincheck
        username=u&credential=p&realm=X&ajax=1&just_logged_in=1
S→C  200 Set-Cookie: SVPNCOOKIE=...                (or 405 / 401 / ret= tokeninfo challenge)
C→S  GET  /remote/fortisslvpn_xml?dual_stack=1     (Cookie: SVPNCOOKIE=...)
S→C  200 <sslvpn-tunnel ...>                       (IP, DNS, routes, timeouts)
C→S  [TLS #1 or #2] GET /remote/sslvpn-tunnel      (Cookie: SVPNCOOKIE=...)
S→C  (no HTTP response — tunnel frames begin)
C→S  frame{ FF 03 C0 21 01 01 00 0A 01 04 <MRU> 05 04 <magic> }   LCP ConfReq
S→C  frame{ FF 03 C0 21 01 05 00 0C 01 04 05 46 05 04 <magic> }   LCP ConfReq (server)
C→S  frame{ FF 03 C0 21 02 05 00 0C 01 04 05 46 05 04 <magic> }   LCP ConfAck
S→C  frame{ FF 03 C0 21 02 01 00 0A 01 04 <MRU> 05 04 <magic> }   LCP ConfAck (ours)
C→S  frame{ FF 03 80 21 01 01 00 16 03 04 00 00 00 00
            81 04 00 00 00 00 83 04 00 00 00 00 }                 IPCP ConfReq (zero IP+DNS)
S→C  frame{ FF 03 80 21 03 01 00 16 03 04 <assigned-IP>
            81 04 <DNS1> 83 04 <DNS2> }                           IPCP ConfNak (assigned)
C→S  frame{ FF 03 80 21 01 02 00 16 03 04 <assigned-IP>
            81 04 <DNS1> 83 04 <DNS2> }                           IPCP ConfReq (final)
S→C  frame{ FF 03 80 21 02 02 00 16 ... }                          IPCP ConfAck
     ... userspace IP packets as frame{ FF 03 00 21 <IPv4 packet> } ...
C→S  frame{ FF 03 C0 21 09 <id> 00 08 <magic> } every dpd s of silence (Echo-Req)
S→C  frame{ FF 03 C0 21 0A <id> 00 08 <server magic> }             (Echo-Rep)
     teardown:
C→S  frame{ FF 03 C0 21 05 <id> 00 04 }                            LCP TermReq
S→C  frame{ FF 03 C0 21 06 <id> 00 04 }                            LCP TermAck
C→S  [new TLS] GET /remote/logout
```

---

## Source references

All URLs fetched 2026-09-30 from the `master` branch (openconnect) / `master`
branch (openfortivpn). Local copies of the fetched files were consulted; line
numbers refer to those revisions.

**openconnect** — https://gitlab.com/openconnect/openconnect

- `fortinet.c` — https://gitlab.com/openconnect/openconnect/-/raw/master/fortinet.c
  - clthello/svrhello strings & UA override: lines 39-68
  - auth flow incl. JS redirect, logincheck POST, SVPNCOOKIE, tokeninfo 2FA,
    401-HTML 2FA, 405 handling: lines 98-342
  - XML config example & parsing (routes, DNS, IP, timeouts, DTLS): lines 344-643
  - config fetch, tunnel GET request build, DTLS hello build: lines 645-773
  - tunnel connect sequence & no-HTTP-response quirk: lines 775-835
  - DTLS svrhello validation: lines 837-872
  - logout: lines 874-901
- `ppp.c` — https://gitlab.com/openconnect/openconnect/-/raw/master/ppp.c
  - HDLC/FCS helpers (not used by Fortinet encap): lines 25-158
  - encap setup (`encap_len = 6`, PFC/ACCOMP stripped): lines 249-294
  - TLV builders, LCP/ICP packet framing: lines 327-375
  - server CONFREQ handling (MRU coax, magic, rej/nak/ack): lines 379-541
  - client CONFREQ construction (LCP/IPCP/IP6CP): lines 543-635
  - rej/nak handling (assigned IP, DNS): lines 637-774
  - code dispatch, echo/term handling, PROTREJ: lines 776-869
  - state machine: lines 871-1031
  - PPP header construction (`FF 03`, proto): lines 1033-1045
  - HTTP-response detection: lines 1047-1056
  - mainloop: Fortinet frame parse 0x5050 (lines 1188-1197), frame build
    (lines 1480-1486), keepalive/DPD actions (lines 1415-1427), buffer sizing
    (lines 1079-1083), concat/split handling (lines 1137-1340)
  - TERMREQ/TERMACK teardown with 1 s wait: lines 963-1011
- `ppp.h` — https://gitlab.com/openconnect/openconnect/-/raw/master/ppp.h
  - protocol & code constants: lines 21-63; LCP option tags 65-77; IPCP tags
    79-92
- `mainloop.c` — https://gitlab.com/openconnect/openconnect/-/raw/master/mainloop.c
  - keepalive/DPD deadline logic: lines 424-497
- `openconnect-internal.h` — https://gitlab.com/openconnect/openconnect/-/raw/master/openconnect-internal.h
  - `KA_*` action codes: lines 238-242; `PPP_ENCAP_*` constants: lines 263-268
- `http.c` — https://gitlab.com/openconnect/openconnect/-/raw/master/http.c
  - common headers (Host/User-Agent/Cookie): lines 1422-1437

**openfortivpn** — https://github.com/adrienverge/openfortivpn (cross-check)

- `src/io.c` — https://raw.githubusercontent.com/adrienverge/openfortivpn/master/src/io.c
  - 6-byte 0x5050 frame parse/build and HTTP/1 error interception: lines 440-540
- `src/http.c` — https://raw.githubusercontent.com/adrienverge/openfortivpn/master/src/http.c
  - request template & headers: lines 271-294
  - `ret=` parsing (0=fail, 1=ok, 6=unsupported): lines 340-424, 718-741
  - SVPNCOOKIE extraction: lines 421-430
  - login POST bodies (`username/credential/realm/ajax`): lines 691-711
  - 2FA second-stage POST parameters (`reqid,polid,grp,portal,peer,code,code2,magic`,
    `ftmpush=1`): lines 761-830
  - `/remote/fortisslvpn` allocation request: line 872; `/remote/fortisslvpn_xml`:
    line 961; logout: line 861
- `src/tunnel.c` — https://raw.githubusercontent.com/adrienverge/openfortivpn/master/src/tunnel.c
  - overall flow & `GET /remote/sslvpn-tunnel` with `Host: sslvpn`: lines 1380-1432
- `src/main.c` — https://raw.githubusercontent.com/adrienverge/openfortivpn/master/src/main.c
  - default User-Agent `Mozilla/5.0 SV1`: line 691
