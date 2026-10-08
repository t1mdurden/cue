// The other side of the call ("them"): everything this Mac plays, through a Core Audio process tap
// (macOS 14.2+), as mono 16-bit little-endian PCM on stdout. Also answers for the permission the tap
// needs, System Audio Recording, which has no public status call: the TCC functions are looked up at
// runtime (the approach of insidegui/AudioCap), and their absence reads as not-determined.
//   swiftc -O native/system-audio.swift -o bin/system-audio
//   bin/system-audio status     # granted | denied | not-determined
//   bin/system-audio request    # asks macOS (the prompt names the app that started this helper)
//   bin/system-audio [--sample-rate 48000] [--chunk-duration 0.05] > them.pcm
import AVFoundation
import AudioToolbox
import CoreAudio
import Foundation

func fail(_ message: String) -> Never {
  FileHandle.standardError.write("system-audio: \(message)\n".data(using: .utf8)!)
  exit(1)
}

// ---- permission ---------------------------------------------------------------------------------
let tcc = dlopen("/System/Library/PrivateFrameworks/TCC.framework/Versions/A/TCC", RTLD_NOW)
typealias Preflight = @convention(c) (CFString, CFDictionary?) -> Int
typealias Request = @convention(c) (CFString, CFDictionary?, @escaping (Bool) -> Void) -> Void
let service = "kTCCServiceAudioCapture" as CFString

func permissionStatus() -> String {
  guard let tcc, let symbol = dlsym(tcc, "TCCAccessPreflight") else { return "not-determined" }
  switch unsafeBitCast(symbol, to: Preflight.self)(service, nil) {
  case 0: return "granted"
  case 1: return "denied"
  default: return "not-determined"
  }
}

func requestPermission() -> String {
  guard let tcc, let symbol = dlsym(tcc, "TCCAccessRequest") else { return permissionStatus() }
  let done = DispatchSemaphore(value: 0)
  var granted = false
  unsafeBitCast(symbol, to: Request.self)(service, nil) { granted = $0; done.signal() }
  _ = done.wait(timeout: .now() + 300)   // the person reads the prompt; don't hang forever
  return granted ? "granted" : permissionStatus()
}

let args = Array(CommandLine.arguments.dropFirst())
if args.first == "status" { print(permissionStatus()); exit(0) }
if args.first == "request" { print(requestPermission()); exit(0) }

func option(_ name: String, _ fallback: Double) -> Double {
  guard let i = args.firstIndex(of: name), i + 1 < args.count, let value = Double(args[i + 1]) else { return fallback }
  return value
}
let sampleRate = option("--sample-rate", 48000)
let chunkBytes = Int(sampleRate * option("--chunk-duration", 0.05)) * 2

// ---- the tap ------------------------------------------------------------------------------------
func address(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
  AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
}

func read<T>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, _ initial: T) -> T {
  var value = initial
  var addr = address(selector)
  var size = UInt32(MemoryLayout<T>.size)
  let status = withUnsafeMutablePointer(to: &value) { AudioObjectGetPropertyData(object, &addr, 0, nil, &size, $0) }
  if status != noErr { fail("reading property \(selector) failed (\(status))") }
  return value
}

let output = read(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultSystemOutputDevice, AudioDeviceID(0))
let outputUID = read(output, kAudioDevicePropertyDeviceUID, "" as CFString) as String

// Everything played, mixed to mono; the helper's own process plays nothing, so nothing to exclude.
let tapDescription = CATapDescription(monoGlobalTapButExcludeProcesses: [])
tapDescription.uuid = UUID()
tapDescription.muteBehavior = .unmuted
tapDescription.isPrivate = true
var tap = AudioObjectID(kAudioObjectUnknown)
var status = AudioHardwareCreateProcessTap(tapDescription, &tap)
if status != noErr { fail("could not create the system audio tap (\(status)); is System Audio Recording allowed?") }

var tapFormat = read(tap, kAudioTapPropertyFormat, AudioStreamBasicDescription())
guard let inputFormat = AVAudioFormat(streamDescription: &tapFormat),
      let outputFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: sampleRate, channels: 1, interleaved: true),
      let converter = AVAudioConverter(from: inputFormat, to: outputFormat) else { fail("unsupported tap format \(tapFormat)") }

let aggregate: [String: Any] = [
  kAudioAggregateDeviceNameKey: "Cue system audio",
  kAudioAggregateDeviceUIDKey: UUID().uuidString,
  kAudioAggregateDeviceMainSubDeviceKey: outputUID,
  kAudioAggregateDeviceIsPrivateKey: true,
  kAudioAggregateDeviceIsStackedKey: false,
  kAudioAggregateDeviceTapAutoStartKey: true,
  kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
  kAudioAggregateDeviceTapListKey: [[kAudioSubTapDriftCompensationKey: true, kAudioSubTapUIDKey: tapDescription.uuid.uuidString]],
]
var device = AudioObjectID(kAudioObjectUnknown)
status = AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &device)
if status != noErr { AudioHardwareDestroyProcessTap(tap); fail("could not create the capture device (\(status))") }

var procID: AudioDeviceIOProcID?
func cleanup() {
  AudioDeviceStop(device, procID)
  if let procID { AudioDeviceDestroyIOProcID(device, procID) }
  AudioHardwareDestroyAggregateDevice(device)
  AudioHardwareDestroyProcessTap(tap)
}

signal(SIGPIPE, SIG_IGN)   // a closed stdout surfaces as a write error below, and ends the helper
let stdout = FileHandle.standardOutput
var pending = Data()
let queue = DispatchQueue(label: "cue.system-audio")
status = AudioDeviceCreateIOProcIDWithBlock(&procID, device, queue) { _, input, _, _, _ in
  guard let buffer = AVAudioPCMBuffer(pcmFormat: inputFormat, bufferListNoCopy: input, deallocator: nil), buffer.frameLength > 0 else { return }
  let capacity = AVAudioFrameCount(Double(buffer.frameLength) * sampleRate / inputFormat.sampleRate) + 32
  guard let converted = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else { return }
  var fed = false
  var error: NSError?
  converter.convert(to: converted, error: &error) { _, inputStatus in
    if fed { inputStatus.pointee = .noDataNow; return nil }
    fed = true
    inputStatus.pointee = .haveData
    return buffer
  }
  if let error { fail("conversion failed: \(error.localizedDescription)") }
  pending.append(Data(bytes: converted.int16ChannelData![0], count: Int(converted.frameLength) * 2))
  while pending.count >= chunkBytes {
    do { try stdout.write(contentsOf: pending.prefix(chunkBytes)) } catch { cleanup(); exit(0) }   // reader went away
    pending.removeFirst(chunkBytes)
  }
}
if status != noErr { cleanup(); fail("could not attach to the capture device (\(status))") }
status = AudioDeviceStart(device, procID)
if status != noErr { cleanup(); fail("could not start capturing (\(status))") }
FileHandle.standardError.write("system-audio: capturing \(inputFormat.sampleRate) Hz -> \(sampleRate) Hz mono s16le\n".data(using: .utf8)!)

var sources: [DispatchSourceSignal] = []
for sig in [SIGTERM, SIGINT] {
  signal(sig, SIG_IGN)
  let source = DispatchSource.makeSignalSource(signal: sig, queue: queue)
  source.setEventHandler { cleanup(); exit(0) }
  source.resume()
  sources.append(source)
}
dispatchMain()
