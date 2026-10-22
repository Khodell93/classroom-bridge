"""Bluetooth LE "beacon" so iPads can find the AirPlay receiver when network discovery can't reach them.

iPads normally find AirPlay receivers with mDNS (Bonjour), which stays inside one network segment. In schools
the iPads' Wi-Fi and the classroom PCs are often on different segments, so the PC never appears under Screen
Mirroring, while Apple TVs do (IT lets those through a Bonjour gateway). Apple devices also listen for a short
Bluetooth LE advert that carries a receiver's IP address and port; an iPad near the PC then lists it and
connects over the normal network. This is the same advert UxPlay's uxplay-beacon.py sends (its winrt module).

Needs Windows 10/11 and Bluetooth 4.0 or later that can advertise; a cheap USB Bluetooth adapter is enough.
"""

import ipaddress
import pathlib
import socket
import struct
import sys
import time


def local_ipv4():
    """The PC's address on the network it uses to reach the outside world (no traffic is sent)."""
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("8.8.8.8", 80))
        return probe.getsockname()[0]
    except OSError:
        return socket.gethostbyname(socket.gethostname())
    finally:
        probe.close()


def receiver_port(ble_file, timeout=120):  # the first start can spend a minute building the plugin cache
    """UxPlay writes its AirPlay TCP port (little-endian) to the -ble file once it is listening."""
    path = pathlib.Path(ble_file)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            data = path.read_bytes()
            if len(data) >= 2:
                return struct.unpack("<H", data[:2])[0]
        except OSError:
            pass
        time.sleep(0.25)
    return None


def advert_bytes(ipv4, port):
    # Apple data unit type 9 (AirPlay target), length 8, flags 0x13, seed 0x30, then IPv4 and port (big-endian).
    return bytes([0x09, 0x08, 0x13, 0x30]) + ipaddress.IPv4Address(ipv4).packed + port.to_bytes(2, "big")


class Beacon:
    def __init__(self):
        self.publisher = None
        self.address = None

    def start(self, ipv4, port):
        """Starts advertising. Returns None on success, or a short reason it can't run on this PC."""
        self.stop()
        if sys.platform != "win32":
            return "Bluetooth discovery is only needed on Windows."
        try:
            from winrt.windows.devices.bluetooth.advertisement import (
                BluetoothLEAdvertisement, BluetoothLEAdvertisementPublisher, BluetoothLEAdvertisementPublisherStatus,
                BluetoothLEManufacturerData,
            )
            from winrt.windows.storage.streams import DataWriter
        except ImportError:
            return "Bluetooth support is missing from this build."
        try:
            writer = DataWriter()
            writer.write_bytes(advert_bytes(ipv4, port))
            data = BluetoothLEManufacturerData()
            data.company_id = 0x004C  # Apple
            data.data = writer.detach_buffer()
            advertisement = BluetoothLEAdvertisement()
            advertisement.manufacturer_data.append(data)
            publisher = BluetoothLEAdvertisementPublisher(advertisement)
            publisher.start()
            # Without a usable adapter the publisher is aborted (or never leaves "waiting") within a moment.
            for _ in range(20):
                time.sleep(0.1)
                if publisher.status in (BluetoothLEAdvertisementPublisherStatus.STARTED, BluetoothLEAdvertisementPublisherStatus.ABORTED):
                    break
            if publisher.status != BluetoothLEAdvertisementPublisherStatus.STARTED:
                try:
                    publisher.stop()
                except Exception:
                    pass
                return "No Bluetooth adapter that can advertise was found."
        except Exception as error:
            return f"Bluetooth is unavailable ({str(error)[:60] or type(error).__name__})."
        self.publisher = publisher
        self.address = f"{ipv4}:{port}"
        return None

    @property
    def running(self):
        return self.publisher is not None

    def stop(self):
        publisher, self.publisher = self.publisher, None
        self.address = None
        if publisher is not None:
            try:
                publisher.stop()
            except Exception:
                pass
