export const VPN_GUIDE = "https://wiki.uni-freiburg.de/rz/doku.php?id=vpn"

export const VPN_MESSAGE = `UFR answered with its "VPN erforderlich" page — connect to the uni VPN (${VPN_GUIDE})`

/** Off the VPN, UFR answers every path with HTTP 200 and this page (measured 2026-09-28). */
export function isVpnPage(html: string): boolean {
  return /VPN erforderlich|Zugriff eingeschr/i.test(html)
}
