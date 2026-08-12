# ESP32 Dual Air & Soil Monitoring System — Complete Wiring Guide

This document provides the complete pinout schematic and wiring instructions for interfacing all air, soil, display, storage, and RTC modules with the **ESP32 Development Board**.

---

## 📋 Components List & I2C Address Map

| Component | Function / Parameters | Bus / Interface | Default Address / Pin | Operating Voltage |
| :--- | :--- | :--- | :--- | :--- |
| **ESP32 Dev Board** | Main Microcontroller & Wi-Fi/Firebase Gateway | — | — | 5V USB / 3.3V |
| **BME280** | Air Temperature, Humidity & Barometric Pressure | $I^2C$ | `0x76` (or `0x77`) | 3.3V |
| **AHT20** | Secondary Air Temperature & Humidity Sensor | $I^2C$ | `0x38` | 3.3V |
| **DS3231 RTC** | Real-Time Clock & Hardware Timestamping | $I^2C$ | `0x68` | 3.3V / 5V |
| **SSD1306 OLED** | 128x64 Monochrome Graphical Display | $I^2C$ | `0x3C` | 3.3V |
| **DS18B20** | Waterproof Soil Temperature Probe | OneWire | **GPIO 4** | 3.3V / 5V |
| **Capacitive Moisture v1.2** | Corrosion-Resistant Soil Moisture Sensor | Analog ADC | **GPIO 34** (ADC1_CH6) | 3.3V |
| **Resistive Moisture (FC-28)** | Soil Electrical Conductivity & Moisture Sensor | Analog ADC | **GPIO 35** (ADC1_CH7) | 3.3V |
| **MicroSD Card Module** | Local CSV Datalogging | SPI | **CS: GPIO 5** | 5V / 3.3V |

---

## 🔌 Pin-by-Pin Wiring Connections

### 1. Shared $I^2C$ Bus Devices (4 Modules on 2 Wire Pins)
All four $I^2C$ modules share the exact same SDA and SCL lines on the ESP32.

```
ESP32 GPIO 21 (SDA) ───┬─── BME280 SDA
                       ├─── AHT20 SDA
                       ├─── DS3231 SDA
                       └─── SSD1306 OLED SDA

ESP32 GPIO 22 (SCL) ───┬─── BME280 SCL
                       ├─── AHT20 SCL
                       ├─── DS3231 SCL
                       └─── SSD1306 OLED SCL
```

| Sensor / Module | Module Pin | ESP32 Pin | Power Rail | Notes |
| :--- | :--- | :--- | :--- | :--- |
| **BME280** | VCC | `3.3V` | 3.3V Rail | Do NOT connect to 5V! |
| | GND | `GND` | Common GND | |
| | SDA | `GPIO 21` | $I^2C$ Data | Shared SDA |
| | SCL | `GPIO 22` | $I^2C$ Clock | Shared SCL |
| **AHT20** | VCC | `3.3V` | 3.3V Rail | |
| | GND | `GND` | Common GND | |
| | SDA | `GPIO 21` | $I^2C$ Data | Shared SDA |
| | SCL | `GPIO 22` | $I^2C$ Clock | Shared SCL |
| **DS3231 RTC** | VCC | `3.3V` / `VIN` | 3.3V / 5V Rail | |
| | GND | `GND` | Common GND | |
| | SDA | `GPIO 21` | $I^2C$ Data | Shared SDA |
| | SCL | `GPIO 22` | $I^2C$ Clock | Shared SCL |
| **SSD1306 OLED**| VCC | `3.3V` | 3.3V Rail | |
| | GND | `GND` | Common GND | |
| | SDA | `GPIO 21` | $I^2C$ Data | Shared SDA |
| | SCL | `GPIO 22` | $I^2C$ Clock | Shared SCL |

---

### 2. OneWire Soil Temperature Sensor (DS18B20)

> **IMPORTANT:** A $4.7\text{ k}\Omega$ pull-up resistor must be connected between the **VCC** (Red) and **DATA** (Yellow) wires of the DS18B20 probe to ensure stable OneWire communication.

| Wire Color | DS18B20 Function | ESP32 Connection | Notes |
| :--- | :--- | :--- | :--- |
| **Red** | VCC ($3.3\text{V} - 5\text{V}$) | `3.3V` / `VIN` | Connects to one leg of $4.7\text{k}\Omega$ resistor |
| **Yellow / White** | DATA | `GPIO 4` | Connects to second leg of $4.7\text{k}\Omega$ resistor |
| **Black / Blue** | GND | `GND` | Common Ground |

---

### 3. Analog Soil Moisture Sensors

> **ADC Note:** On ESP32, use ADC1 pins (`GPIO 34`, `GPIO 35`, `GPIO 36`, `GPIO 39`) because ADC2 pins are disabled when Wi-Fi is active.

| Sensor | Sensor Pin | ESP32 Pin | Power Rail | Notes |
| :--- | :--- | :--- | :--- | :--- |
| **Capacitive Soil v1.2** | VCC | `3.3V` | 3.3V Rail | Prevents sensor corrosion |
| | GND | `GND` | Common GND | |
| | AOUT / SIG | `GPIO 34` | ADC1_CH6 | Analog voltage output |
| **Resistive Soil (FC-28)**| VCC / VCC Pin | `3.3V` | 3.3V Rail | Power via digital pin optional |
| | GND | `GND` | Common GND | |
| | AOUT | `GPIO 35` | ADC1_CH7 | Analog voltage output |

---

### 4. MicroSD Card Reader Module (SPI Bus)

| MicroSD Module Pin | ESP32 Pin | SPI Function | Power Rail / Notes |
| :--- | :--- | :--- | :--- |
| **VCC** | `VIN` / `5V` | Power | Requires 5V for onboard 3.3V LDO regulator |
| **GND** | `GND` | Ground | Common Ground |
| **CS** (Chip Select) | `GPIO 5` | SS / CS | Hardware SPI CS |
| **MOSI** | `GPIO 23` | VSPI MOSI | SPI Master Out Slave In |
| **MISO** | `GPIO 19` | VSPI MISO | SPI Master In Slave Out |
| **SCK / CLK** | `GPIO 18` | VSPI SCK | SPI Clock |

---

## 🪛 Power Supply & Breadboard Bus Summary

```
=============================================================================
                          ESP32 POWER & GROUND RAILS
=============================================================================
 [3.3V Rail] ────► BME280 (VCC), AHT20 (VCC), SSD1306 (VCC), 
                   Capacitive Moisture (VCC), Resistive Moisture (VCC), 
                   DS18B20 (VCC + 4.7k Pullup)

 [5V / VIN Rail] ──► MicroSD Module (VCC), DS3231 RTC (VCC)

 [GND Rail] ─────► COMMON GROUND for ALL modules and ESP32 GND
=============================================================================
```

---

## ⚡ Troubleshooting & Verification Checklist

1. **$I^2C$ Bus Scanner:**
   If any $I^2C$ device is missing, upload an $I^2C$ scanner sketch. Devices should show:
   * `0x38` $\rightarrow$ AHT20
   * `0x3C` $\rightarrow$ SSD1306 OLED
   * `0x68` $\rightarrow$ DS3231 RTC
   * `0x76` or `0x77` $\rightarrow$ BME280

2. **DS18B20 `-127.00 °C` Error:**
   Indicates missing or loose $4.7\text{ k}\Omega$ pull-up resistor between GPIO 4 and 3.3V.

3. **SD Card Initialization Failed:**
   Ensure SD card is formatted as **FAT32** (32GB max) and VCC is connected to **5V / VIN**.

4. **Analog Soil Readings Jumping:**
   Ensure all sensors share a single solid ground connection back to ESP32 GND.
