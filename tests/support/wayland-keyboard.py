import sys

from gi.repository import Gio, GLib


connection = Gio.bus_get_sync(Gio.BusType.SESSION, None)
service = "org.gnome.Mutter.RemoteDesktop"
session = connection.call_sync(
    service, "/org/gnome/Mutter/RemoteDesktop", service, "CreateSession",
    None, GLib.VariantType("(o)"), Gio.DBusCallFlags.NONE, 5000, None
).unpack()[0]
interface = service + ".Session"


def call(method, parameters=None):
    return connection.call_sync(
        service, session, interface, method, parameters, None,
        Gio.DBusCallFlags.NONE, 5000, None
    )


call("Start")
try:
    call("NotifyKeyboardKeycode", GLib.Variant("(ub)", (30, True)))
    call("NotifyKeyboardKeycode", GLib.Variant("(ub)", (30, False)))
    print("READY", flush=True)
    sys.stdin.read()
finally:
    call("Stop")
