import {
  CWSandboxAuthenticationError,
  CWSandboxConfigurationError,
  CWSandboxNotFoundError,
  CWSandboxResourceExhaustedError,
  CWSandboxTimeoutError,
  CWSandboxTransportError,
  CWSandboxUnavailableError,
  CWSandboxValidationError,
  commandForWorkingDirectory,
  isAdvancedResources,
  normalizeFileContent,
  normalizeMountedFiles,
  normalizePorts,
  validateRequestOptions
} from "./chunk-Z66QY2W7.js";

// src/node/generated/coreweave/sandbox/v1beta2/gateway.ts
import { ServiceType as ServiceType2 } from "@protobuf-ts/runtime-rpc";
import { WireType as WireType3 } from "@protobuf-ts/runtime";
import { UnknownFieldHandler as UnknownFieldHandler3 } from "@protobuf-ts/runtime";
import { reflectionMergePartial as reflectionMergePartial3 } from "@protobuf-ts/runtime";
import { MessageType as MessageType3 } from "@protobuf-ts/runtime";

// src/node/generated/google/protobuf/timestamp.ts
import { WireType } from "@protobuf-ts/runtime";
import { UnknownFieldHandler } from "@protobuf-ts/runtime";
import { reflectionMergePartial } from "@protobuf-ts/runtime";
import { typeofJsonValue } from "@protobuf-ts/runtime";
import { PbLong } from "@protobuf-ts/runtime";
import { MessageType } from "@protobuf-ts/runtime";
var Timestamp$Type = class extends MessageType {
  constructor() {
    super("google.protobuf.Timestamp", [
      {
        no: 1,
        name: "seconds",
        kind: "scalar",
        T: 3
        /*ScalarType.INT64*/
      },
      {
        no: 2,
        name: "nanos",
        kind: "scalar",
        T: 5
        /*ScalarType.INT32*/
      }
    ]);
  }
  /**
   * Creates a new `Timestamp` for the current time.
   */
  now() {
    const msg = this.create();
    const ms = Date.now();
    msg.seconds = PbLong.from(Math.floor(ms / 1e3)).toString();
    msg.nanos = ms % 1e3 * 1e6;
    return msg;
  }
  /**
   * Converts a `Timestamp` to a JavaScript Date.
   */
  toDate(message) {
    return new Date(PbLong.from(message.seconds).toNumber() * 1e3 + Math.ceil(message.nanos / 1e6));
  }
  /**
   * Converts a JavaScript Date to a `Timestamp`.
   */
  fromDate(date) {
    const msg = this.create();
    const ms = date.getTime();
    msg.seconds = PbLong.from(Math.floor(ms / 1e3)).toString();
    msg.nanos = (ms % 1e3 + (ms < 0 && ms % 1e3 !== 0 ? 1e3 : 0)) * 1e6;
    return msg;
  }
  /**
   * In JSON format, the `Timestamp` type is encoded as a string
   * in the RFC 3339 format.
   */
  internalJsonWrite(message, options) {
    let ms = PbLong.from(message.seconds).toNumber() * 1e3;
    if (ms < Date.parse("0001-01-01T00:00:00Z") || ms > Date.parse("9999-12-31T23:59:59Z"))
      throw new Error("Unable to encode Timestamp to JSON. Must be from 0001-01-01T00:00:00Z to 9999-12-31T23:59:59Z inclusive.");
    if (message.nanos < 0)
      throw new Error("Unable to encode invalid Timestamp to JSON. Nanos must not be negative.");
    let z = "Z";
    if (message.nanos > 0) {
      let nanosStr = (message.nanos + 1e9).toString().substring(1);
      if (nanosStr.substring(3) === "000000")
        z = "." + nanosStr.substring(0, 3) + "Z";
      else if (nanosStr.substring(6) === "000")
        z = "." + nanosStr.substring(0, 6) + "Z";
      else
        z = "." + nanosStr + "Z";
    }
    return new Date(ms).toISOString().replace(".000Z", z);
  }
  /**
   * In JSON format, the `Timestamp` type is encoded as a string
   * in the RFC 3339 format.
   */
  internalJsonRead(json, options, target) {
    if (typeof json !== "string")
      throw new Error("Unable to parse Timestamp from JSON " + typeofJsonValue(json) + ".");
    let matches = json.match(/^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:Z|\.([0-9]{3,9})Z|([+-][0-9][0-9]:[0-9][0-9]))$/);
    if (!matches)
      throw new Error("Unable to parse Timestamp from JSON. Invalid format.");
    let ms = Date.parse(matches[1] + "-" + matches[2] + "-" + matches[3] + "T" + matches[4] + ":" + matches[5] + ":" + matches[6] + (matches[8] ? matches[8] : "Z"));
    if (Number.isNaN(ms))
      throw new Error("Unable to parse Timestamp from JSON. Invalid value.");
    if (ms < Date.parse("0001-01-01T00:00:00Z") || ms > Date.parse("9999-12-31T23:59:59Z"))
      throw new globalThis.Error("Unable to parse Timestamp from JSON. Must be from 0001-01-01T00:00:00Z to 9999-12-31T23:59:59Z inclusive.");
    if (!target)
      target = this.create();
    target.seconds = PbLong.from(ms / 1e3).toString();
    target.nanos = 0;
    if (matches[7])
      target.nanos = parseInt("1" + matches[7] + "0".repeat(9 - matches[7].length)) - 1e9;
    return target;
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.seconds = "0";
    message.nanos = 0;
    if (value !== void 0)
      reflectionMergePartial(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* int64 seconds */
        1:
          message.seconds = reader.int64().toString();
          break;
        case /* int32 nanos */
        2:
          message.nanos = reader.int32();
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.seconds !== "0")
      writer.tag(1, WireType.Varint).int64(message.seconds);
    if (message.nanos !== 0)
      writer.tag(2, WireType.Varint).int32(message.nanos);
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var Timestamp = new Timestamp$Type();

// src/node/generated/coreweave/sandbox/v1beta2/secrets.ts
import { ServiceType } from "@protobuf-ts/runtime-rpc";
import { WireType as WireType2 } from "@protobuf-ts/runtime";
import { UnknownFieldHandler as UnknownFieldHandler2 } from "@protobuf-ts/runtime";
import { reflectionMergePartial as reflectionMergePartial2 } from "@protobuf-ts/runtime";
import { MessageType as MessageType2 } from "@protobuf-ts/runtime";
var SecretStoreProviderType = /* @__PURE__ */ ((SecretStoreProviderType2) => {
  SecretStoreProviderType2[SecretStoreProviderType2["UNSPECIFIED"] = 0] = "UNSPECIFIED";
  SecretStoreProviderType2[SecretStoreProviderType2["WANDB"] = 1] = "WANDB";
  return SecretStoreProviderType2;
})(SecretStoreProviderType || {});
var SecretStoreReference$Type = class extends MessageType2 {
  constructor() {
    super("coreweave.sandbox.v1beta2.SecretStoreReference", [
      {
        no: 1,
        name: "store_name",
        kind: "scalar",
        T: 9
        /*ScalarType.STRING*/
      },
      { no: 2, name: "secrets", kind: "message", repeat: 2, T: () => SecretMapping }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.storeName = "";
    message.secrets = [];
    if (value !== void 0)
      reflectionMergePartial2(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* string store_name */
        1:
          message.storeName = reader.string();
          break;
        case /* repeated coreweave.sandbox.v1beta2.SecretMapping secrets */
        2:
          message.secrets.push(SecretMapping.internalBinaryRead(reader, reader.uint32(), options));
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler2.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.storeName !== "")
      writer.tag(1, WireType2.LengthDelimited).string(message.storeName);
    for (let i = 0; i < message.secrets.length; i++)
      SecretMapping.internalBinaryWrite(message.secrets[i], writer.tag(2, WireType2.LengthDelimited).fork(), options).join();
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler2.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var SecretStoreReference = new SecretStoreReference$Type();
var SecretMapping$Type = class extends MessageType2 {
  constructor() {
    super("coreweave.sandbox.v1beta2.SecretMapping", [
      {
        no: 1,
        name: "path",
        kind: "scalar",
        T: 9
        /*ScalarType.STRING*/
      },
      {
        no: 2,
        name: "field",
        kind: "scalar",
        T: 9
        /*ScalarType.STRING*/
      },
      {
        no: 3,
        name: "env_var",
        kind: "scalar",
        T: 9
        /*ScalarType.STRING*/
      }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.path = "";
    message.field = "";
    message.envVar = "";
    if (value !== void 0)
      reflectionMergePartial2(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* string path */
        1:
          message.path = reader.string();
          break;
        case /* string field */
        2:
          message.field = reader.string();
          break;
        case /* string env_var */
        3:
          message.envVar = reader.string();
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler2.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.path !== "")
      writer.tag(1, WireType2.LengthDelimited).string(message.path);
    if (message.field !== "")
      writer.tag(2, WireType2.LengthDelimited).string(message.field);
    if (message.envVar !== "")
      writer.tag(3, WireType2.LengthDelimited).string(message.envVar);
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler2.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var SecretMapping = new SecretMapping$Type();
var ResolvedSecret$Type = class extends MessageType2 {
  constructor() {
    super("coreweave.sandbox.v1beta2.ResolvedSecret", [
      {
        no: 1,
        name: "env_var",
        kind: "scalar",
        T: 9
        /*ScalarType.STRING*/
      },
      {
        no: 2,
        name: "value",
        kind: "scalar",
        T: 12
        /*ScalarType.BYTES*/
      }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.envVar = "";
    message.value = new Uint8Array(0);
    if (value !== void 0)
      reflectionMergePartial2(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* string env_var */
        1:
          message.envVar = reader.string();
          break;
        case /* bytes value */
        2:
          message.value = reader.bytes();
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler2.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.envVar !== "")
      writer.tag(1, WireType2.LengthDelimited).string(message.envVar);
    if (message.value.length)
      writer.tag(2, WireType2.LengthDelimited).bytes(message.value);
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler2.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var ResolvedSecret = new ResolvedSecret$Type();
var WandBStoreConfig$Type = class extends MessageType2 {
  constructor() {
    super("coreweave.sandbox.v1beta2.WandBStoreConfig", [
      {
        no: 1,
        name: "api_url",
        kind: "scalar",
        T: 9
        /*ScalarType.STRING*/
      },
      {
        no: 2,
        name: "team",
        kind: "scalar",
        T: 9
        /*ScalarType.STRING*/
      }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.apiUrl = "";
    message.team = "";
    if (value !== void 0)
      reflectionMergePartial2(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* string api_url */
        1:
          message.apiUrl = reader.string();
          break;
        case /* string team */
        2:
          message.team = reader.string();
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler2.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.apiUrl !== "")
      writer.tag(1, WireType2.LengthDelimited).string(message.apiUrl);
    if (message.team !== "")
      writer.tag(2, WireType2.LengthDelimited).string(message.team);
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler2.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var WandBStoreConfig = new WandBStoreConfig$Type();
var SecretStore$Type = class extends MessageType2 {
  constructor() {
    super("coreweave.sandbox.v1beta2.SecretStore", [
      { no: 1, name: "id", kind: "scalar", T: 9, options: { "google.api.field_behavior": ["OUTPUT_ONLY"] } },
      { no: 2, name: "organization_id", kind: "scalar", T: 9, options: { "google.api.field_behavior": ["OUTPUT_ONLY"] } },
      {
        no: 3,
        name: "name",
        kind: "scalar",
        T: 9
        /*ScalarType.STRING*/
      },
      { no: 4, name: "provider_type", kind: "enum", T: () => ["coreweave.sandbox.v1beta2.SecretStoreProviderType", SecretStoreProviderType, "SECRET_STORE_PROVIDER_TYPE_"] },
      { no: 10, name: "wandb", kind: "message", oneof: "providerConfig", T: () => WandBStoreConfig },
      { no: 20, name: "created_at", kind: "message", T: () => Timestamp, options: { "google.api.field_behavior": ["OUTPUT_ONLY"] } },
      { no: 21, name: "updated_at", kind: "message", T: () => Timestamp, options: { "google.api.field_behavior": ["OUTPUT_ONLY"] } }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.id = "";
    message.organizationId = "";
    message.name = "";
    message.providerType = 0;
    message.providerConfig = { oneofKind: void 0 };
    if (value !== void 0)
      reflectionMergePartial2(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* string id */
        1:
          message.id = reader.string();
          break;
        case /* string organization_id */
        2:
          message.organizationId = reader.string();
          break;
        case /* string name */
        3:
          message.name = reader.string();
          break;
        case /* coreweave.sandbox.v1beta2.SecretStoreProviderType provider_type */
        4:
          message.providerType = reader.int32();
          break;
        case /* coreweave.sandbox.v1beta2.WandBStoreConfig wandb */
        10:
          message.providerConfig = {
            oneofKind: "wandb",
            wandb: WandBStoreConfig.internalBinaryRead(reader, reader.uint32(), options, message.providerConfig.wandb)
          };
          break;
        case /* google.protobuf.Timestamp created_at */
        20:
          message.createdAt = Timestamp.internalBinaryRead(reader, reader.uint32(), options, message.createdAt);
          break;
        case /* google.protobuf.Timestamp updated_at */
        21:
          message.updatedAt = Timestamp.internalBinaryRead(reader, reader.uint32(), options, message.updatedAt);
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler2.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.id !== "")
      writer.tag(1, WireType2.LengthDelimited).string(message.id);
    if (message.organizationId !== "")
      writer.tag(2, WireType2.LengthDelimited).string(message.organizationId);
    if (message.name !== "")
      writer.tag(3, WireType2.LengthDelimited).string(message.name);
    if (message.providerType !== 0)
      writer.tag(4, WireType2.Varint).int32(message.providerType);
    if (message.providerConfig.oneofKind === "wandb")
      WandBStoreConfig.internalBinaryWrite(message.providerConfig.wandb, writer.tag(10, WireType2.LengthDelimited).fork(), options).join();
    if (message.createdAt)
      Timestamp.internalBinaryWrite(message.createdAt, writer.tag(20, WireType2.LengthDelimited).fork(), options).join();
    if (message.updatedAt)
      Timestamp.internalBinaryWrite(message.updatedAt, writer.tag(21, WireType2.LengthDelimited).fork(), options).join();
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler2.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var SecretStore = new SecretStore$Type();
var CreateSecretStoreRequest$Type = class extends MessageType2 {
  constructor() {
    super("coreweave.sandbox.v1beta2.CreateSecretStoreRequest", [
      { no: 1, name: "name", kind: "scalar", T: 9, options: { "google.api.field_behavior": ["REQUIRED"] } },
      { no: 2, name: "provider_type", kind: "enum", T: () => ["coreweave.sandbox.v1beta2.SecretStoreProviderType", SecretStoreProviderType, "SECRET_STORE_PROVIDER_TYPE_"], options: { "google.api.field_behavior": ["REQUIRED"] } },
      { no: 10, name: "wandb", kind: "message", oneof: "providerConfig", T: () => WandBStoreConfig }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.name = "";
    message.providerType = 0;
    message.providerConfig = { oneofKind: void 0 };
    if (value !== void 0)
      reflectionMergePartial2(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* string name */
        1:
          message.name = reader.string();
          break;
        case /* coreweave.sandbox.v1beta2.SecretStoreProviderType provider_type */
        2:
          message.providerType = reader.int32();
          break;
        case /* coreweave.sandbox.v1beta2.WandBStoreConfig wandb */
        10:
          message.providerConfig = {
            oneofKind: "wandb",
            wandb: WandBStoreConfig.internalBinaryRead(reader, reader.uint32(), options, message.providerConfig.wandb)
          };
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler2.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.name !== "")
      writer.tag(1, WireType2.LengthDelimited).string(message.name);
    if (message.providerType !== 0)
      writer.tag(2, WireType2.Varint).int32(message.providerType);
    if (message.providerConfig.oneofKind === "wandb")
      WandBStoreConfig.internalBinaryWrite(message.providerConfig.wandb, writer.tag(10, WireType2.LengthDelimited).fork(), options).join();
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler2.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var CreateSecretStoreRequest = new CreateSecretStoreRequest$Type();
var CreateSecretStoreResponse$Type = class extends MessageType2 {
  constructor() {
    super("coreweave.sandbox.v1beta2.CreateSecretStoreResponse", [
      { no: 1, name: "secret_store", kind: "message", T: () => SecretStore }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    if (value !== void 0)
      reflectionMergePartial2(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* coreweave.sandbox.v1beta2.SecretStore secret_store */
        1:
          message.secretStore = SecretStore.internalBinaryRead(reader, reader.uint32(), options, message.secretStore);
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler2.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.secretStore)
      SecretStore.internalBinaryWrite(message.secretStore, writer.tag(1, WireType2.LengthDelimited).fork(), options).join();
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler2.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var CreateSecretStoreResponse = new CreateSecretStoreResponse$Type();
var GetSecretStoreRequest$Type = class extends MessageType2 {
  constructor() {
    super("coreweave.sandbox.v1beta2.GetSecretStoreRequest", [
      { no: 1, name: "name", kind: "scalar", T: 9, options: { "google.api.field_behavior": ["REQUIRED"] } }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.name = "";
    if (value !== void 0)
      reflectionMergePartial2(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* string name */
        1:
          message.name = reader.string();
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler2.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.name !== "")
      writer.tag(1, WireType2.LengthDelimited).string(message.name);
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler2.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var GetSecretStoreRequest = new GetSecretStoreRequest$Type();
var GetSecretStoreResponse$Type = class extends MessageType2 {
  constructor() {
    super("coreweave.sandbox.v1beta2.GetSecretStoreResponse", [
      { no: 1, name: "secret_store", kind: "message", T: () => SecretStore }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    if (value !== void 0)
      reflectionMergePartial2(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* coreweave.sandbox.v1beta2.SecretStore secret_store */
        1:
          message.secretStore = SecretStore.internalBinaryRead(reader, reader.uint32(), options, message.secretStore);
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler2.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.secretStore)
      SecretStore.internalBinaryWrite(message.secretStore, writer.tag(1, WireType2.LengthDelimited).fork(), options).join();
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler2.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var GetSecretStoreResponse = new GetSecretStoreResponse$Type();
var ListSecretStoresRequest$Type = class extends MessageType2 {
  constructor() {
    super("coreweave.sandbox.v1beta2.ListSecretStoresRequest", [
      {
        no: 1,
        name: "page_size",
        kind: "scalar",
        T: 5
        /*ScalarType.INT32*/
      },
      {
        no: 2,
        name: "page_token",
        kind: "scalar",
        T: 9
        /*ScalarType.STRING*/
      }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.pageSize = 0;
    message.pageToken = "";
    if (value !== void 0)
      reflectionMergePartial2(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* int32 page_size */
        1:
          message.pageSize = reader.int32();
          break;
        case /* string page_token */
        2:
          message.pageToken = reader.string();
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler2.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.pageSize !== 0)
      writer.tag(1, WireType2.Varint).int32(message.pageSize);
    if (message.pageToken !== "")
      writer.tag(2, WireType2.LengthDelimited).string(message.pageToken);
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler2.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var ListSecretStoresRequest = new ListSecretStoresRequest$Type();
var ListSecretStoresResponse$Type = class extends MessageType2 {
  constructor() {
    super("coreweave.sandbox.v1beta2.ListSecretStoresResponse", [
      { no: 1, name: "secret_stores", kind: "message", repeat: 2, T: () => SecretStore },
      {
        no: 2,
        name: "next_page_token",
        kind: "scalar",
        T: 9
        /*ScalarType.STRING*/
      }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.secretStores = [];
    message.nextPageToken = "";
    if (value !== void 0)
      reflectionMergePartial2(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* repeated coreweave.sandbox.v1beta2.SecretStore secret_stores */
        1:
          message.secretStores.push(SecretStore.internalBinaryRead(reader, reader.uint32(), options));
          break;
        case /* string next_page_token */
        2:
          message.nextPageToken = reader.string();
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler2.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    for (let i = 0; i < message.secretStores.length; i++)
      SecretStore.internalBinaryWrite(message.secretStores[i], writer.tag(1, WireType2.LengthDelimited).fork(), options).join();
    if (message.nextPageToken !== "")
      writer.tag(2, WireType2.LengthDelimited).string(message.nextPageToken);
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler2.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var ListSecretStoresResponse = new ListSecretStoresResponse$Type();
var DeleteSecretStoreRequest$Type = class extends MessageType2 {
  constructor() {
    super("coreweave.sandbox.v1beta2.DeleteSecretStoreRequest", [
      { no: 1, name: "name", kind: "scalar", T: 9, options: { "google.api.field_behavior": ["REQUIRED"] } }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.name = "";
    if (value !== void 0)
      reflectionMergePartial2(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* string name */
        1:
          message.name = reader.string();
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler2.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.name !== "")
      writer.tag(1, WireType2.LengthDelimited).string(message.name);
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler2.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var DeleteSecretStoreRequest = new DeleteSecretStoreRequest$Type();
var DeleteSecretStoreResponse$Type = class extends MessageType2 {
  constructor() {
    super("coreweave.sandbox.v1beta2.DeleteSecretStoreResponse", []);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    if (value !== void 0)
      reflectionMergePartial2(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler2.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler2.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var DeleteSecretStoreResponse = new DeleteSecretStoreResponse$Type();
var SecretStoreService = new ServiceType("coreweave.sandbox.v1beta2.SecretStoreService", [
  { name: "CreateSecretStore", options: { "google.api.http": { post: "/v1beta2/secretstores", body: "*" } }, I: CreateSecretStoreRequest, O: CreateSecretStoreResponse },
  { name: "GetSecretStore", options: { "google.api.http": { get: "/v1beta2/secretstores/{name}" } }, I: GetSecretStoreRequest, O: GetSecretStoreResponse },
  { name: "ListSecretStores", options: { "google.api.http": { get: "/v1beta2/secretstores" } }, I: ListSecretStoresRequest, O: ListSecretStoresResponse },
  { name: "DeleteSecretStore", options: { "google.api.http": { delete: "/v1beta2/secretstores/{name}" } }, I: DeleteSecretStoreRequest, O: DeleteSecretStoreResponse }
]);

// src/node/generated/coreweave/sandbox/v1beta2/gateway.ts
var OutputPolicy = /* @__PURE__ */ ((OutputPolicy2) => {
  OutputPolicy2[OutputPolicy2["UNSPECIFIED"] = 0] = "UNSPECIFIED";
  OutputPolicy2[OutputPolicy2["BUFFERED"] = 1] = "BUFFERED";
  OutputPolicy2[OutputPolicy2["STREAM"] = 2] = "STREAM";
  OutputPolicy2[OutputPolicy2["DISCARD"] = 3] = "DISCARD";
  return OutputPolicy2;
})(OutputPolicy || {});
var SandboxStatus = /* @__PURE__ */ ((SandboxStatus2) => {
  SandboxStatus2[SandboxStatus2["UNSPECIFIED"] = 0] = "UNSPECIFIED";
  SandboxStatus2[SandboxStatus2["CREATING"] = 1] = "CREATING";
  SandboxStatus2[SandboxStatus2["RUNNING"] = 2] = "RUNNING";
  SandboxStatus2[SandboxStatus2["COMPLETED"] = 3] = "COMPLETED";
  SandboxStatus2[SandboxStatus2["FAILED"] = 4] = "FAILED";
  SandboxStatus2[SandboxStatus2["TERMINATED"] = 5] = "TERMINATED";
  SandboxStatus2[SandboxStatus2["PENDING"] = 6] = "PENDING";
  SandboxStatus2[SandboxStatus2["PAUSED"] = 7] = "PAUSED";
  SandboxStatus2[SandboxStatus2["TERMINATING"] = 9] = "TERMINATING";
  return SandboxStatus2;
})(SandboxStatus || {});
var FileSystemSnapshotStatus = /* @__PURE__ */ ((FileSystemSnapshotStatus2) => {
  FileSystemSnapshotStatus2[FileSystemSnapshotStatus2["UNSPECIFIED"] = 0] = "UNSPECIFIED";
  FileSystemSnapshotStatus2[FileSystemSnapshotStatus2["CREATING"] = 1] = "CREATING";
  FileSystemSnapshotStatus2[FileSystemSnapshotStatus2["READY"] = 2] = "READY";
  FileSystemSnapshotStatus2[FileSystemSnapshotStatus2["FAILED"] = 3] = "FAILED";
  FileSystemSnapshotStatus2[FileSystemSnapshotStatus2["DELETING"] = 4] = "DELETING";
  return FileSystemSnapshotStatus2;
})(FileSystemSnapshotStatus || {});
var FileSystemSnapshotTrigger = /* @__PURE__ */ ((FileSystemSnapshotTrigger2) => {
  FileSystemSnapshotTrigger2[FileSystemSnapshotTrigger2["UNSPECIFIED"] = 0] = "UNSPECIFIED";
  FileSystemSnapshotTrigger2[FileSystemSnapshotTrigger2["STOP"] = 1] = "STOP";
  FileSystemSnapshotTrigger2[FileSystemSnapshotTrigger2["MANUAL"] = 2] = "MANUAL";
  return FileSystemSnapshotTrigger2;
})(FileSystemSnapshotTrigger || {});
var ActionType = /* @__PURE__ */ ((ActionType2) => {
  ActionType2[ActionType2["UNSPECIFIED"] = 0] = "UNSPECIFIED";
  ActionType2[ActionType2["EXEC"] = 1] = "EXEC";
  ActionType2[ActionType2["ADD_FILE"] = 2] = "ADD_FILE";
  ActionType2[ActionType2["RETRIEVE_FILE"] = 3] = "RETRIEVE_FILE";
  ActionType2[ActionType2["GET_LOGS"] = 4] = "GET_LOGS";
  ActionType2[ActionType2["SNAPSHOT"] = 5] = "SNAPSHOT";
  ActionType2[ActionType2["RESTORE"] = 6] = "RESTORE";
  ActionType2[ActionType2["STATUS"] = 7] = "STATUS";
  ActionType2[ActionType2["STOP"] = 8] = "STOP";
  return ActionType2;
})(ActionType || {});
var ObjectStoragePermission = /* @__PURE__ */ ((ObjectStoragePermission2) => {
  ObjectStoragePermission2[ObjectStoragePermission2["UNSPECIFIED"] = 0] = "UNSPECIFIED";
  ObjectStoragePermission2[ObjectStoragePermission2["READ"] = 1] = "READ";
  ObjectStoragePermission2[ObjectStoragePermission2["READ_WRITE"] = 2] = "READ_WRITE";
  return ObjectStoragePermission2;
})(ObjectStoragePermission || {});
var MountedFile$Type = class extends MessageType3 {
  constructor() {
    super("coreweave.sandbox.v1beta2.MountedFile", [
      { no: 1, name: "mount_path", kind: "scalar", T: 9, options: { "google.api.field_behavior": ["REQUIRED"] } },
      { no: 2, name: "file_content", kind: "scalar", T: 12, options: { "google.api.field_behavior": ["REQUIRED"] } }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.mountPath = "";
    message.fileContent = new Uint8Array(0);
    if (value !== void 0)
      reflectionMergePartial3(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* string mount_path */
        1:
          message.mountPath = reader.string();
          break;
        case /* bytes file_content */
        2:
          message.fileContent = reader.bytes();
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler3.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.mountPath !== "")
      writer.tag(1, WireType3.LengthDelimited).string(message.mountPath);
    if (message.fileContent.length)
      writer.tag(2, WireType3.LengthDelimited).bytes(message.fileContent);
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler3.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var MountedFile = new MountedFile$Type();
var GpuRequest$Type = class extends MessageType3 {
  constructor() {
    super("coreweave.sandbox.v1beta2.GpuRequest", [
      {
        no: 1,
        name: "gpu_count",
        kind: "scalar",
        T: 3
        /*ScalarType.INT64*/
      },
      {
        no: 2,
        name: "gpu_type",
        kind: "scalar",
        oneof: "spec",
        T: 9
        /*ScalarType.STRING*/
      },
      {
        no: 3,
        name: "gpu_memory_gb",
        kind: "scalar",
        oneof: "spec",
        T: 3
        /*ScalarType.INT64*/
      }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.gpuCount = "0";
    message.spec = { oneofKind: void 0 };
    if (value !== void 0)
      reflectionMergePartial3(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* int64 gpu_count */
        1:
          message.gpuCount = reader.int64().toString();
          break;
        case /* string gpu_type */
        2:
          message.spec = {
            oneofKind: "gpuType",
            gpuType: reader.string()
          };
          break;
        case /* int64 gpu_memory_gb */
        3:
          message.spec = {
            oneofKind: "gpuMemoryGb",
            gpuMemoryGb: reader.int64().toString()
          };
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler3.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.gpuCount !== "0")
      writer.tag(1, WireType3.Varint).int64(message.gpuCount);
    if (message.spec.oneofKind === "gpuType")
      writer.tag(2, WireType3.LengthDelimited).string(message.spec.gpuType);
    if (message.spec.oneofKind === "gpuMemoryGb")
      writer.tag(3, WireType3.Varint).int64(message.spec.gpuMemoryGb);
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler3.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var GpuRequest = new GpuRequest$Type();
var ResourceRequest$Type = class extends MessageType3 {
  constructor() {
    super("coreweave.sandbox.v1beta2.ResourceRequest", [
      { no: 1, name: "cpu", kind: "scalar", T: 9, options: { "google.api.field_behavior": ["OPTIONAL"] } },
      { no: 2, name: "memory", kind: "scalar", T: 9, options: { "google.api.field_behavior": ["OPTIONAL"] } },
      { no: 3, name: "gpu", kind: "message", T: () => GpuRequest, options: { "google.api.field_behavior": ["OPTIONAL"] } }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.cpu = "";
    message.memory = "";
    if (value !== void 0)
      reflectionMergePartial3(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* string cpu */
        1:
          message.cpu = reader.string();
          break;
        case /* string memory */
        2:
          message.memory = reader.string();
          break;
        case /* coreweave.sandbox.v1beta2.GpuRequest gpu */
        3:
          message.gpu = GpuRequest.internalBinaryRead(reader, reader.uint32(), options, message.gpu);
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler3.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.cpu !== "")
      writer.tag(1, WireType3.LengthDelimited).string(message.cpu);
    if (message.memory !== "")
      writer.tag(2, WireType3.LengthDelimited).string(message.memory);
    if (message.gpu)
      GpuRequest.internalBinaryWrite(message.gpu, writer.tag(3, WireType3.LengthDelimited).fork(), options).join();
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler3.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var ResourceRequest = new ResourceRequest$Type();
var Port$Type = class extends MessageType3 {
  constructor() {
    super("coreweave.sandbox.v1beta2.Port", [
      { no: 1, name: "container_port", kind: "scalar", T: 5, options: { "google.api.field_behavior": ["REQUIRED"] } },
      { no: 2, name: "name", kind: "scalar", T: 9, options: { "google.api.field_behavior": ["OPTIONAL"] } },
      { no: 3, name: "protocol", kind: "scalar", T: 9, options: { "google.api.field_behavior": ["OPTIONAL"] } }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.containerPort = 0;
    message.name = "";
    message.protocol = "";
    if (value !== void 0)
      reflectionMergePartial3(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* int32 container_port */
        1:
          message.containerPort = reader.int32();
          break;
        case /* string name */
        2:
          message.name = reader.string();
          break;
        case /* string protocol */
        3:
          message.protocol = reader.string();
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler3.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.containerPort !== 0)
      writer.tag(1, WireType3.Varint).int32(message.containerPort);
    if (message.name !== "")
      writer.tag(2, WireType3.LengthDelimited).string(message.name);
    if (message.protocol !== "")
      writer.tag(3, WireType3.LengthDelimited).string(message.protocol);
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler3.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var Port = new Port$Type();
var ServiceConfig$Type = class extends MessageType3 {
  constructor() {
    super("coreweave.sandbox.v1beta2.ServiceConfig", [
      { no: 1, name: "exposed_ports", kind: "scalar", repeat: 1, T: 5, options: { "google.api.field_behavior": ["REQUIRED"] } }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.exposedPorts = [];
    if (value !== void 0)
      reflectionMergePartial3(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* repeated int32 exposed_ports */
        1:
          if (wireType === WireType3.LengthDelimited)
            for (let e = reader.int32() + reader.pos; reader.pos < e; )
              message.exposedPorts.push(reader.int32());
          else
            message.exposedPorts.push(reader.int32());
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler3.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.exposedPorts.length) {
      writer.tag(1, WireType3.LengthDelimited).fork();
      for (let i = 0; i < message.exposedPorts.length; i++)
        writer.int32(message.exposedPorts[i]);
      writer.join();
    }
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler3.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var ServiceConfig = new ServiceConfig$Type();
var NetworkOptions$Type = class extends MessageType3 {
  constructor() {
    super("coreweave.sandbox.v1beta2.NetworkOptions", [
      { no: 1, name: "ingress_mode", kind: "scalar", T: 9, options: { "google.api.field_behavior": ["OPTIONAL"] } },
      { no: 2, name: "exposed_ports", kind: "scalar", repeat: 1, T: 5, options: { "google.api.field_behavior": ["OPTIONAL"] } },
      { no: 3, name: "egress_mode", kind: "scalar", T: 9, options: { "google.api.field_behavior": ["OPTIONAL"] } }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.ingressMode = "";
    message.exposedPorts = [];
    message.egressMode = "";
    if (value !== void 0)
      reflectionMergePartial3(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* string ingress_mode */
        1:
          message.ingressMode = reader.string();
          break;
        case /* repeated int32 exposed_ports */
        2:
          if (wireType === WireType3.LengthDelimited)
            for (let e = reader.int32() + reader.pos; reader.pos < e; )
              message.exposedPorts.push(reader.int32());
          else
            message.exposedPorts.push(reader.int32());
          break;
        case /* string egress_mode */
        3:
          message.egressMode = reader.string();
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler3.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.ingressMode !== "")
      writer.tag(1, WireType3.LengthDelimited).string(message.ingressMode);
    if (message.exposedPorts.length) {
      writer.tag(2, WireType3.LengthDelimited).fork();
      for (let i = 0; i < message.exposedPorts.length; i++)
        writer.int32(message.exposedPorts[i]);
      writer.join();
    }
    if (message.egressMode !== "")
      writer.tag(3, WireType3.LengthDelimited).string(message.egressMode);
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler3.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var NetworkOptions = new NetworkOptions$Type();
var KubernetesSecretSource$Type = class extends MessageType3 {
  constructor() {
    super("coreweave.sandbox.v1beta2.KubernetesSecretSource", [
      { no: 1, name: "secret_name", kind: "scalar", T: 9, options: { "google.api.field_behavior": ["REQUIRED"] } },
      { no: 2, name: "secret_key", kind: "scalar", T: 9, options: { "google.api.field_behavior": ["REQUIRED"] } }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.secretName = "";
    message.secretKey = "";
    if (value !== void 0)
      reflectionMergePartial3(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* string secret_name */
        1:
          message.secretName = reader.string();
          break;
        case /* string secret_key */
        2:
          message.secretKey = reader.string();
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler3.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.secretName !== "")
      writer.tag(1, WireType3.LengthDelimited).string(message.secretName);
    if (message.secretKey !== "")
      writer.tag(2, WireType3.LengthDelimited).string(message.secretKey);
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler3.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var KubernetesSecretSource = new KubernetesSecretSource$Type();
var RunnerClusterSecretReference$Type = class extends MessageType3 {
  constructor() {
    super("coreweave.sandbox.v1beta2.RunnerClusterSecretReference", [
      { no: 1, name: "kubernetes", kind: "message", oneof: "source", T: () => KubernetesSecretSource },
      { no: 10, name: "env_var", kind: "scalar", T: 9, options: { "google.api.field_behavior": ["REQUIRED"] } }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.source = { oneofKind: void 0 };
    message.envVar = "";
    if (value !== void 0)
      reflectionMergePartial3(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* coreweave.sandbox.v1beta2.KubernetesSecretSource kubernetes */
        1:
          message.source = {
            oneofKind: "kubernetes",
            kubernetes: KubernetesSecretSource.internalBinaryRead(reader, reader.uint32(), options, message.source.kubernetes)
          };
          break;
        case /* string env_var */
        10:
          message.envVar = reader.string();
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler3.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.source.oneofKind === "kubernetes")
      KubernetesSecretSource.internalBinaryWrite(message.source.kubernetes, writer.tag(1, WireType3.LengthDelimited).fork(), options).join();
    if (message.envVar !== "")
      writer.tag(10, WireType3.LengthDelimited).string(message.envVar);
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler3.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var RunnerClusterSecretReference = new RunnerClusterSecretReference$Type();
var S3Mount$Type = class extends MessageType3 {
  constructor() {
    super("coreweave.sandbox.v1beta2.S3Mount", [
      { no: 1, name: "bucket", kind: "scalar", T: 9, options: { "google.api.field_behavior": ["REQUIRED"] } },
      { no: 2, name: "directory", kind: "scalar", T: 9, options: { "google.api.field_behavior": ["REQUIRED"] } },
      { no: 3, name: "mount_path", kind: "scalar", T: 9, options: { "google.api.field_behavior": ["REQUIRED"] } }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.bucket = "";
    message.directory = "";
    message.mountPath = "";
    if (value !== void 0)
      reflectionMergePartial3(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* string bucket */
        1:
          message.bucket = reader.string();
          break;
        case /* string directory */
        2:
          message.directory = reader.string();
          break;
        case /* string mount_path */
        3:
          message.mountPath = reader.string();
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler3.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.bucket !== "")
      writer.tag(1, WireType3.LengthDelimited).string(message.bucket);
    if (message.directory !== "")
      writer.tag(2, WireType3.LengthDelimited).string(message.directory);
    if (message.mountPath !== "")
      writer.tag(3, WireType3.LengthDelimited).string(message.mountPath);
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler3.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var S3Mount = new S3Mount$Type();
var FileSystemSnapshotSource$Type = class extends MessageType3 {
  constructor() {
    super("coreweave.sandbox.v1beta2.FileSystemSnapshotSource", [
      { no: 1, name: "file_system_snapshot_id", kind: "scalar", T: 9, options: { "google.api.field_behavior": ["OPTIONAL"] } }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.fileSystemSnapshotId = "";
    if (value !== void 0)
      reflectionMergePartial3(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* string file_system_snapshot_id */
        1:
          message.fileSystemSnapshotId = reader.string();
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler3.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.fileSystemSnapshotId !== "")
      writer.tag(1, WireType3.LengthDelimited).string(message.fileSystemSnapshotId);
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler3.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var FileSystemSnapshotSource = new FileSystemSnapshotSource$Type();
var SandboxFileSystemMount$Type = class extends MessageType3 {
  constructor() {
    super("coreweave.sandbox.v1beta2.SandboxFileSystemMount", [
      { no: 1, name: "mount_path", kind: "scalar", T: 9, options: { "google.api.field_behavior": ["REQUIRED"] } },
      { no: 2, name: "size", kind: "scalar", T: 9, options: { "google.api.field_behavior": ["OPTIONAL"] } },
      { no: 3, name: "file_system_snapshot", kind: "message", oneof: "source", T: () => FileSystemSnapshotSource }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.mountPath = "";
    message.size = "";
    message.source = { oneofKind: void 0 };
    if (value !== void 0)
      reflectionMergePartial3(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* string mount_path */
        1:
          message.mountPath = reader.string();
          break;
        case /* string size */
        2:
          message.size = reader.string();
          break;
        case /* coreweave.sandbox.v1beta2.FileSystemSnapshotSource file_system_snapshot */
        3:
          message.source = {
            oneofKind: "fileSystemSnapshot",
            fileSystemSnapshot: FileSystemSnapshotSource.internalBinaryRead(reader, reader.uint32(), options, message.source.fileSystemSnapshot)
          };
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler3.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.mountPath !== "")
      writer.tag(1, WireType3.LengthDelimited).string(message.mountPath);
    if (message.size !== "")
      writer.tag(2, WireType3.LengthDelimited).string(message.size);
    if (message.source.oneofKind === "fileSystemSnapshot")
      FileSystemSnapshotSource.internalBinaryWrite(message.source.fileSystemSnapshot, writer.tag(3, WireType3.LengthDelimited).fork(), options).join();
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler3.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var SandboxFileSystemMount = new SandboxFileSystemMount$Type();
var ExecPayload$Type = class extends MessageType3 {
  constructor() {
    super("coreweave.sandbox.v1beta2.ExecPayload", [
      { no: 1, name: "command", kind: "scalar", T: 9, options: { "google.api.field_behavior": ["REQUIRED"] } },
      { no: 2, name: "args", kind: "scalar", repeat: 2, T: 9, options: { "google.api.field_behavior": ["OPTIONAL"] } }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.command = "";
    message.args = [];
    if (value !== void 0)
      reflectionMergePartial3(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* string command */
        1:
          message.command = reader.string();
          break;
        case /* repeated string args */
        2:
          message.args.push(reader.string());
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler3.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.command !== "")
      writer.tag(1, WireType3.LengthDelimited).string(message.command);
    for (let i = 0; i < message.args.length; i++)
      writer.tag(2, WireType3.LengthDelimited).string(message.args[i]);
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler3.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var ExecPayload = new ExecPayload$Type();
var ExecResponse$Type = class extends MessageType3 {
  constructor() {
    super("coreweave.sandbox.v1beta2.ExecResponse", [
      {
        no: 1,
        name: "stdout",
        kind: "scalar",
        T: 12
        /*ScalarType.BYTES*/
      },
      {
        no: 2,
        name: "stderr",
        kind: "scalar",
        T: 12
        /*ScalarType.BYTES*/
      },
      {
        no: 3,
        name: "exit_code",
        kind: "scalar",
        T: 5
        /*ScalarType.INT32*/
      },
      {
        no: 4,
        name: "stdout_truncated",
        kind: "scalar",
        T: 8
        /*ScalarType.BOOL*/
      },
      {
        no: 5,
        name: "stderr_truncated",
        kind: "scalar",
        T: 8
        /*ScalarType.BOOL*/
      },
      {
        no: 6,
        name: "stdout_bytes_produced",
        kind: "scalar",
        T: 3
        /*ScalarType.INT64*/
      },
      {
        no: 7,
        name: "stderr_bytes_produced",
        kind: "scalar",
        T: 3
        /*ScalarType.INT64*/
      }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.stdout = new Uint8Array(0);
    message.stderr = new Uint8Array(0);
    message.exitCode = 0;
    message.stdoutTruncated = false;
    message.stderrTruncated = false;
    message.stdoutBytesProduced = "0";
    message.stderrBytesProduced = "0";
    if (value !== void 0)
      reflectionMergePartial3(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* bytes stdout */
        1:
          message.stdout = reader.bytes();
          break;
        case /* bytes stderr */
        2:
          message.stderr = reader.bytes();
          break;
        case /* int32 exit_code */
        3:
          message.exitCode = reader.int32();
          break;
        case /* bool stdout_truncated */
        4:
          message.stdoutTruncated = reader.bool();
          break;
        case /* bool stderr_truncated */
        5:
          message.stderrTruncated = reader.bool();
          break;
        case /* int64 stdout_bytes_produced */
        6:
          message.stdoutBytesProduced = reader.int64().toString();
          break;
        case /* int64 stderr_bytes_produced */
        7:
          message.stderrBytesProduced = reader.int64().toString();
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler3.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.stdout.length)
      writer.tag(1, WireType3.LengthDelimited).bytes(message.stdout);
    if (message.stderr.length)
      writer.tag(2, WireType3.LengthDelimited).bytes(message.stderr);
    if (message.exitCode !== 0)
      writer.tag(3, WireType3.Varint).int32(message.exitCode);
    if (message.stdoutTruncated !== false)
      writer.tag(4, WireType3.Varint).bool(message.stdoutTruncated);
    if (message.stderrTruncated !== false)
      writer.tag(5, WireType3.Varint).bool(message.stderrTruncated);
    if (message.stdoutBytesProduced !== "0")
      writer.tag(6, WireType3.Varint).int64(message.stdoutBytesProduced);
    if (message.stderrBytesProduced !== "0")
      writer.tag(7, WireType3.Varint).int64(message.stderrBytesProduced);
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler3.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var ExecResponse = new ExecResponse$Type();
var ResourceUsage$Type = class extends MessageType3 {
  constructor() {
    super("coreweave.sandbox.v1beta2.ResourceUsage", [
      {
        no: 1,
        name: "cpu_millicores_used",
        kind: "scalar",
        T: 3
        /*ScalarType.INT64*/
      },
      {
        no: 2,
        name: "memory_mb_used",
        kind: "scalar",
        T: 3
        /*ScalarType.INT64*/
      },
      {
        no: 3,
        name: "gpu_count_used",
        kind: "scalar",
        T: 3
        /*ScalarType.INT64*/
      }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.cpuMillicoresUsed = "0";
    message.memoryMbUsed = "0";
    message.gpuCountUsed = "0";
    if (value !== void 0)
      reflectionMergePartial3(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* int64 cpu_millicores_used */
        1:
          message.cpuMillicoresUsed = reader.int64().toString();
          break;
        case /* int64 memory_mb_used */
        2:
          message.memoryMbUsed = reader.int64().toString();
          break;
        case /* int64 gpu_count_used */
        3:
          message.gpuCountUsed = reader.int64().toString();
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler3.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.cpuMillicoresUsed !== "0")
      writer.tag(1, WireType3.Varint).int64(message.cpuMillicoresUsed);
    if (message.memoryMbUsed !== "0")
      writer.tag(2, WireType3.Varint).int64(message.memoryMbUsed);
    if (message.gpuCountUsed !== "0")
      writer.tag(3, WireType3.Varint).int64(message.gpuCountUsed);
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler3.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var ResourceUsage = new ResourceUsage$Type();
var ObjectStorageAccess$Type = class extends MessageType3 {
  constructor() {
    super("coreweave.sandbox.v1beta2.ObjectStorageAccess", [
      {
        no: 1,
        name: "buckets",
        kind: "scalar",
        repeat: 2,
        T: 9
        /*ScalarType.STRING*/
      },
      { no: 2, name: "permission", kind: "enum", T: () => ["coreweave.sandbox.v1beta2.ObjectStoragePermission", ObjectStoragePermission, "OBJECT_STORAGE_PERMISSION_"] }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.buckets = [];
    message.permission = 0;
    if (value !== void 0)
      reflectionMergePartial3(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* repeated string buckets */
        1:
          message.buckets.push(reader.string());
          break;
        case /* coreweave.sandbox.v1beta2.ObjectStoragePermission permission */
        2:
          message.permission = reader.int32();
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler3.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    for (let i = 0; i < message.buckets.length; i++)
      writer.tag(1, WireType3.LengthDelimited).string(message.buckets[i]);
    if (message.permission !== 0)
      writer.tag(2, WireType3.Varint).int32(message.permission);
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler3.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var ObjectStorageAccess = new ObjectStorageAccess$Type();
var StartSandboxRequest$Type = class extends MessageType3 {
  constructor() {
    super("coreweave.sandbox.v1beta2.StartSandboxRequest", [
      { no: 1, name: "command", kind: "scalar", T: 9, options: { "google.api.field_behavior": ["REQUIRED"] } },
      { no: 2, name: "args", kind: "scalar", repeat: 2, T: 9, options: { "google.api.field_behavior": ["OPTIONAL"] } },
      { no: 3, name: "tags", kind: "scalar", repeat: 2, T: 9, options: { "google.api.field_behavior": ["OPTIONAL"] } },
      { no: 4, name: "resources", kind: "message", T: () => ResourceRequest, options: { "google.api.field_behavior": ["OPTIONAL"] } },
      { no: 5, name: "container_image", kind: "scalar", T: 9, options: { "google.api.field_behavior": ["REQUIRED"] } },
      { no: 6, name: "environment_variables", kind: "map", K: 9, V: {
        kind: "scalar",
        T: 9
        /*ScalarType.STRING*/
      }, options: { "google.api.field_behavior": ["OPTIONAL"] } },
      { no: 7, name: "ports", kind: "message", repeat: 2, T: () => Port, options: { "google.api.field_behavior": ["OPTIONAL"] } },
      { no: 8, name: "mounted_files", kind: "message", repeat: 2, T: () => MountedFile, options: { "google.api.field_behavior": ["OPTIONAL"] } },
      { no: 9, name: "s3_mount", kind: "message", T: () => S3Mount, options: { "google.api.field_behavior": ["OPTIONAL"] } },
      { no: 10, name: "network", kind: "message", T: () => NetworkOptions, options: { "google.api.field_behavior": ["OPTIONAL"] } },
      { no: 11, name: "file_system", kind: "message", T: () => SandboxFileSystemMount, options: { "google.api.field_behavior": ["OPTIONAL"] } },
      { no: 20, name: "profile_ids", kind: "scalar", repeat: 2, T: 9, options: { "google.api.field_behavior": ["OPTIONAL"] } },
      { no: 21, name: "runner_ids", kind: "scalar", repeat: 2, T: 9, options: { "google.api.field_behavior": ["OPTIONAL"] } },
      { no: 33, name: "profile_names", kind: "scalar", repeat: 2, T: 9, options: { "google.api.field_behavior": ["OPTIONAL"] } },
      { no: 22, name: "max_lifetime_seconds", kind: "scalar", T: 5, options: { "google.api.field_behavior": ["OPTIONAL"] } },
      { no: 23, name: "max_timeout_seconds", kind: "scalar", T: 5, options: { "google.api.field_behavior": ["OPTIONAL"] } },
      { no: 24, name: "runner_cluster_secrets", kind: "message", repeat: 2, T: () => RunnerClusterSecretReference, options: { "google.api.field_behavior": ["OPTIONAL"] } },
      { no: 25, name: "object_storage_access", kind: "message", T: () => ObjectStorageAccess, options: { "google.api.field_behavior": ["OPTIONAL"] } },
      { no: 26, name: "pod_annotations", kind: "map", K: 9, V: {
        kind: "scalar",
        T: 9
        /*ScalarType.STRING*/
      }, options: { "google.api.field_behavior": ["OPTIONAL"] } },
      { no: 30, name: "secret_stores", kind: "message", repeat: 2, T: () => SecretStoreReference, options: { "google.api.field_behavior": ["OPTIONAL"] } },
      { no: 31, name: "resource_limits", kind: "message", T: () => ResourceRequest, options: { "google.api.field_behavior": ["OPTIONAL"] } },
      { no: 32, name: "resource_requests", kind: "message", T: () => ResourceRequest, options: { "google.api.field_behavior": ["OPTIONAL"] } }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.command = "";
    message.args = [];
    message.tags = [];
    message.containerImage = "";
    message.environmentVariables = {};
    message.ports = [];
    message.mountedFiles = [];
    message.profileIds = [];
    message.runnerIds = [];
    message.profileNames = [];
    message.maxLifetimeSeconds = 0;
    message.maxTimeoutSeconds = 0;
    message.runnerClusterSecrets = [];
    message.podAnnotations = {};
    message.secretStores = [];
    if (value !== void 0)
      reflectionMergePartial3(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* string command */
        1:
          message.command = reader.string();
          break;
        case /* repeated string args */
        2:
          message.args.push(reader.string());
          break;
        case /* repeated string tags */
        3:
          message.tags.push(reader.string());
          break;
        case /* coreweave.sandbox.v1beta2.ResourceRequest resources */
        4:
          message.resources = ResourceRequest.internalBinaryRead(reader, reader.uint32(), options, message.resources);
          break;
        case /* string container_image */
        5:
          message.containerImage = reader.string();
          break;
        case /* map<string, string> environment_variables */
        6:
          this.binaryReadMap6(message.environmentVariables, reader, options);
          break;
        case /* repeated coreweave.sandbox.v1beta2.Port ports */
        7:
          message.ports.push(Port.internalBinaryRead(reader, reader.uint32(), options));
          break;
        case /* repeated coreweave.sandbox.v1beta2.MountedFile mounted_files */
        8:
          message.mountedFiles.push(MountedFile.internalBinaryRead(reader, reader.uint32(), options));
          break;
        case /* coreweave.sandbox.v1beta2.S3Mount s3_mount */
        9:
          message.s3Mount = S3Mount.internalBinaryRead(reader, reader.uint32(), options, message.s3Mount);
          break;
        case /* coreweave.sandbox.v1beta2.NetworkOptions network */
        10:
          message.network = NetworkOptions.internalBinaryRead(reader, reader.uint32(), options, message.network);
          break;
        case /* coreweave.sandbox.v1beta2.SandboxFileSystemMount file_system */
        11:
          message.fileSystem = SandboxFileSystemMount.internalBinaryRead(reader, reader.uint32(), options, message.fileSystem);
          break;
        case /* repeated string profile_ids */
        20:
          message.profileIds.push(reader.string());
          break;
        case /* repeated string runner_ids */
        21:
          message.runnerIds.push(reader.string());
          break;
        case /* repeated string profile_names */
        33:
          message.profileNames.push(reader.string());
          break;
        case /* int32 max_lifetime_seconds */
        22:
          message.maxLifetimeSeconds = reader.int32();
          break;
        case /* int32 max_timeout_seconds */
        23:
          message.maxTimeoutSeconds = reader.int32();
          break;
        case /* repeated coreweave.sandbox.v1beta2.RunnerClusterSecretReference runner_cluster_secrets */
        24:
          message.runnerClusterSecrets.push(RunnerClusterSecretReference.internalBinaryRead(reader, reader.uint32(), options));
          break;
        case /* coreweave.sandbox.v1beta2.ObjectStorageAccess object_storage_access */
        25:
          message.objectStorageAccess = ObjectStorageAccess.internalBinaryRead(reader, reader.uint32(), options, message.objectStorageAccess);
          break;
        case /* map<string, string> pod_annotations */
        26:
          this.binaryReadMap26(message.podAnnotations, reader, options);
          break;
        case /* repeated coreweave.sandbox.v1beta2.SecretStoreReference secret_stores */
        30:
          message.secretStores.push(SecretStoreReference.internalBinaryRead(reader, reader.uint32(), options));
          break;
        case /* coreweave.sandbox.v1beta2.ResourceRequest resource_limits */
        31:
          message.resourceLimits = ResourceRequest.internalBinaryRead(reader, reader.uint32(), options, message.resourceLimits);
          break;
        case /* coreweave.sandbox.v1beta2.ResourceRequest resource_requests */
        32:
          message.resourceRequests = ResourceRequest.internalBinaryRead(reader, reader.uint32(), options, message.resourceRequests);
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler3.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  binaryReadMap6(map, reader, options) {
    let len = reader.uint32(), end = reader.pos + len, key, val;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case 1:
          key = reader.string();
          break;
        case 2:
          val = reader.string();
          break;
        default:
          throw new globalThis.Error("unknown map entry field for coreweave.sandbox.v1beta2.StartSandboxRequest.environment_variables");
      }
    }
    map[key ?? ""] = val ?? "";
  }
  binaryReadMap26(map, reader, options) {
    let len = reader.uint32(), end = reader.pos + len, key, val;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case 1:
          key = reader.string();
          break;
        case 2:
          val = reader.string();
          break;
        default:
          throw new globalThis.Error("unknown map entry field for coreweave.sandbox.v1beta2.StartSandboxRequest.pod_annotations");
      }
    }
    map[key ?? ""] = val ?? "";
  }
  internalBinaryWrite(message, writer, options) {
    if (message.command !== "")
      writer.tag(1, WireType3.LengthDelimited).string(message.command);
    for (let i = 0; i < message.args.length; i++)
      writer.tag(2, WireType3.LengthDelimited).string(message.args[i]);
    for (let i = 0; i < message.tags.length; i++)
      writer.tag(3, WireType3.LengthDelimited).string(message.tags[i]);
    if (message.resources)
      ResourceRequest.internalBinaryWrite(message.resources, writer.tag(4, WireType3.LengthDelimited).fork(), options).join();
    if (message.containerImage !== "")
      writer.tag(5, WireType3.LengthDelimited).string(message.containerImage);
    for (let k of globalThis.Object.keys(message.environmentVariables))
      writer.tag(6, WireType3.LengthDelimited).fork().tag(1, WireType3.LengthDelimited).string(k).tag(2, WireType3.LengthDelimited).string(message.environmentVariables[k]).join();
    for (let i = 0; i < message.ports.length; i++)
      Port.internalBinaryWrite(message.ports[i], writer.tag(7, WireType3.LengthDelimited).fork(), options).join();
    for (let i = 0; i < message.mountedFiles.length; i++)
      MountedFile.internalBinaryWrite(message.mountedFiles[i], writer.tag(8, WireType3.LengthDelimited).fork(), options).join();
    if (message.s3Mount)
      S3Mount.internalBinaryWrite(message.s3Mount, writer.tag(9, WireType3.LengthDelimited).fork(), options).join();
    if (message.network)
      NetworkOptions.internalBinaryWrite(message.network, writer.tag(10, WireType3.LengthDelimited).fork(), options).join();
    if (message.fileSystem)
      SandboxFileSystemMount.internalBinaryWrite(message.fileSystem, writer.tag(11, WireType3.LengthDelimited).fork(), options).join();
    for (let i = 0; i < message.profileIds.length; i++)
      writer.tag(20, WireType3.LengthDelimited).string(message.profileIds[i]);
    for (let i = 0; i < message.runnerIds.length; i++)
      writer.tag(21, WireType3.LengthDelimited).string(message.runnerIds[i]);
    if (message.maxLifetimeSeconds !== 0)
      writer.tag(22, WireType3.Varint).int32(message.maxLifetimeSeconds);
    if (message.maxTimeoutSeconds !== 0)
      writer.tag(23, WireType3.Varint).int32(message.maxTimeoutSeconds);
    for (let i = 0; i < message.runnerClusterSecrets.length; i++)
      RunnerClusterSecretReference.internalBinaryWrite(message.runnerClusterSecrets[i], writer.tag(24, WireType3.LengthDelimited).fork(), options).join();
    if (message.objectStorageAccess)
      ObjectStorageAccess.internalBinaryWrite(message.objectStorageAccess, writer.tag(25, WireType3.LengthDelimited).fork(), options).join();
    for (let k of globalThis.Object.keys(message.podAnnotations))
      writer.tag(26, WireType3.LengthDelimited).fork().tag(1, WireType3.LengthDelimited).string(k).tag(2, WireType3.LengthDelimited).string(message.podAnnotations[k]).join();
    for (let i = 0; i < message.secretStores.length; i++)
      SecretStoreReference.internalBinaryWrite(message.secretStores[i], writer.tag(30, WireType3.LengthDelimited).fork(), options).join();
    if (message.resourceLimits)
      ResourceRequest.internalBinaryWrite(message.resourceLimits, writer.tag(31, WireType3.LengthDelimited).fork(), options).join();
    if (message.resourceRequests)
      ResourceRequest.internalBinaryWrite(message.resourceRequests, writer.tag(32, WireType3.LengthDelimited).fork(), options).join();
    for (let i = 0; i < message.profileNames.length; i++)
      writer.tag(33, WireType3.LengthDelimited).string(message.profileNames[i]);
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler3.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var StartSandboxRequest = new StartSandboxRequest$Type();
var StartSandboxResponse$Type = class extends MessageType3 {
  constructor() {
    super("coreweave.sandbox.v1beta2.StartSandboxResponse", [
      {
        no: 1,
        name: "sandbox_id",
        kind: "scalar",
        T: 9
        /*ScalarType.STRING*/
      },
      { no: 2, name: "started_at_time", kind: "message", T: () => Timestamp },
      {
        no: 3,
        name: "service_address",
        kind: "scalar",
        T: 9
        /*ScalarType.STRING*/
      },
      { no: 4, name: "exposed_ports", kind: "message", repeat: 2, T: () => Port },
      { no: 5, name: "requested_resources", kind: "message", T: () => ResourceRequest },
      {
        no: 6,
        name: "profile_id",
        kind: "scalar",
        T: 9
        /*ScalarType.STRING*/
      },
      {
        no: 7,
        name: "runner_id",
        kind: "scalar",
        T: 9
        /*ScalarType.STRING*/
      },
      { no: 8, name: "sandbox_status", kind: "enum", T: () => ["coreweave.sandbox.v1beta2.SandboxStatus", SandboxStatus, "SANDBOX_STATUS_"] },
      {
        no: 9,
        name: "applied_ingress_mode",
        kind: "scalar",
        T: 9
        /*ScalarType.STRING*/
      },
      {
        no: 10,
        name: "applied_egress_mode",
        kind: "scalar",
        T: 9
        /*ScalarType.STRING*/
      },
      { no: 11, name: "requested_resource_limits", kind: "message", T: () => ResourceRequest },
      { no: 12, name: "requested_resource_requests", kind: "message", T: () => ResourceRequest }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.sandboxId = "";
    message.serviceAddress = "";
    message.exposedPorts = [];
    message.profileId = "";
    message.runnerId = "";
    message.sandboxStatus = 0;
    message.appliedIngressMode = "";
    message.appliedEgressMode = "";
    if (value !== void 0)
      reflectionMergePartial3(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* string sandbox_id */
        1:
          message.sandboxId = reader.string();
          break;
        case /* google.protobuf.Timestamp started_at_time */
        2:
          message.startedAtTime = Timestamp.internalBinaryRead(reader, reader.uint32(), options, message.startedAtTime);
          break;
        case /* string service_address */
        3:
          message.serviceAddress = reader.string();
          break;
        case /* repeated coreweave.sandbox.v1beta2.Port exposed_ports */
        4:
          message.exposedPorts.push(Port.internalBinaryRead(reader, reader.uint32(), options));
          break;
        case /* coreweave.sandbox.v1beta2.ResourceRequest requested_resources */
        5:
          message.requestedResources = ResourceRequest.internalBinaryRead(reader, reader.uint32(), options, message.requestedResources);
          break;
        case /* string profile_id */
        6:
          message.profileId = reader.string();
          break;
        case /* string runner_id */
        7:
          message.runnerId = reader.string();
          break;
        case /* coreweave.sandbox.v1beta2.SandboxStatus sandbox_status */
        8:
          message.sandboxStatus = reader.int32();
          break;
        case /* string applied_ingress_mode */
        9:
          message.appliedIngressMode = reader.string();
          break;
        case /* string applied_egress_mode */
        10:
          message.appliedEgressMode = reader.string();
          break;
        case /* coreweave.sandbox.v1beta2.ResourceRequest requested_resource_limits */
        11:
          message.requestedResourceLimits = ResourceRequest.internalBinaryRead(reader, reader.uint32(), options, message.requestedResourceLimits);
          break;
        case /* coreweave.sandbox.v1beta2.ResourceRequest requested_resource_requests */
        12:
          message.requestedResourceRequests = ResourceRequest.internalBinaryRead(reader, reader.uint32(), options, message.requestedResourceRequests);
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler3.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.sandboxId !== "")
      writer.tag(1, WireType3.LengthDelimited).string(message.sandboxId);
    if (message.startedAtTime)
      Timestamp.internalBinaryWrite(message.startedAtTime, writer.tag(2, WireType3.LengthDelimited).fork(), options).join();
    if (message.serviceAddress !== "")
      writer.tag(3, WireType3.LengthDelimited).string(message.serviceAddress);
    for (let i = 0; i < message.exposedPorts.length; i++)
      Port.internalBinaryWrite(message.exposedPorts[i], writer.tag(4, WireType3.LengthDelimited).fork(), options).join();
    if (message.requestedResources)
      ResourceRequest.internalBinaryWrite(message.requestedResources, writer.tag(5, WireType3.LengthDelimited).fork(), options).join();
    if (message.profileId !== "")
      writer.tag(6, WireType3.LengthDelimited).string(message.profileId);
    if (message.runnerId !== "")
      writer.tag(7, WireType3.LengthDelimited).string(message.runnerId);
    if (message.sandboxStatus !== 0)
      writer.tag(8, WireType3.Varint).int32(message.sandboxStatus);
    if (message.appliedIngressMode !== "")
      writer.tag(9, WireType3.LengthDelimited).string(message.appliedIngressMode);
    if (message.appliedEgressMode !== "")
      writer.tag(10, WireType3.LengthDelimited).string(message.appliedEgressMode);
    if (message.requestedResourceLimits)
      ResourceRequest.internalBinaryWrite(message.requestedResourceLimits, writer.tag(11, WireType3.LengthDelimited).fork(), options).join();
    if (message.requestedResourceRequests)
      ResourceRequest.internalBinaryWrite(message.requestedResourceRequests, writer.tag(12, WireType3.LengthDelimited).fork(), options).join();
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler3.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var StartSandboxResponse = new StartSandboxResponse$Type();
var StopSandboxRequest$Type = class extends MessageType3 {
  constructor() {
    super("coreweave.sandbox.v1beta2.StopSandboxRequest", [
      { no: 1, name: "sandbox_id", kind: "scalar", T: 9, options: { "google.api.field_behavior": ["REQUIRED"] } },
      { no: 2, name: "graceful_shutdown_seconds", kind: "scalar", T: 5, options: { "google.api.field_behavior": ["OPTIONAL"] } },
      { no: 3, name: "file_system_snapshot_on_stop", kind: "scalar", T: 8, options: { "google.api.field_behavior": ["OPTIONAL"] } },
      { no: 4, name: "max_timeout_seconds", kind: "scalar", T: 5, options: { "google.api.field_behavior": ["OPTIONAL"] } },
      { no: 5, name: "idempotency_key", kind: "scalar", T: 9, options: { "google.api.field_behavior": ["OPTIONAL"] } },
      { no: 6, name: "wait_for_ready", kind: "scalar", opt: true, T: 8, options: { "google.api.field_behavior": ["OPTIONAL"] } }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.sandboxId = "";
    message.gracefulShutdownSeconds = 0;
    message.fileSystemSnapshotOnStop = false;
    message.maxTimeoutSeconds = 0;
    message.idempotencyKey = "";
    if (value !== void 0)
      reflectionMergePartial3(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* string sandbox_id */
        1:
          message.sandboxId = reader.string();
          break;
        case /* int32 graceful_shutdown_seconds */
        2:
          message.gracefulShutdownSeconds = reader.int32();
          break;
        case /* bool file_system_snapshot_on_stop */
        3:
          message.fileSystemSnapshotOnStop = reader.bool();
          break;
        case /* int32 max_timeout_seconds */
        4:
          message.maxTimeoutSeconds = reader.int32();
          break;
        case /* string idempotency_key */
        5:
          message.idempotencyKey = reader.string();
          break;
        case /* optional bool wait_for_ready */
        6:
          message.waitForReady = reader.bool();
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler3.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.sandboxId !== "")
      writer.tag(1, WireType3.LengthDelimited).string(message.sandboxId);
    if (message.gracefulShutdownSeconds !== 0)
      writer.tag(2, WireType3.Varint).int32(message.gracefulShutdownSeconds);
    if (message.fileSystemSnapshotOnStop !== false)
      writer.tag(3, WireType3.Varint).bool(message.fileSystemSnapshotOnStop);
    if (message.maxTimeoutSeconds !== 0)
      writer.tag(4, WireType3.Varint).int32(message.maxTimeoutSeconds);
    if (message.idempotencyKey !== "")
      writer.tag(5, WireType3.LengthDelimited).string(message.idempotencyKey);
    if (message.waitForReady !== void 0)
      writer.tag(6, WireType3.Varint).bool(message.waitForReady);
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler3.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var StopSandboxRequest = new StopSandboxRequest$Type();
var StopSandboxResponse$Type = class extends MessageType3 {
  constructor() {
    super("coreweave.sandbox.v1beta2.StopSandboxResponse", [
      {
        no: 1,
        name: "success",
        kind: "scalar",
        T: 8
        /*ScalarType.BOOL*/
      },
      {
        no: 2,
        name: "error_message",
        kind: "scalar",
        T: 9
        /*ScalarType.STRING*/
      },
      {
        no: 3,
        name: "file_system_snapshot_id",
        kind: "scalar",
        T: 9
        /*ScalarType.STRING*/
      }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.success = false;
    message.errorMessage = "";
    message.fileSystemSnapshotId = "";
    if (value !== void 0)
      reflectionMergePartial3(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* bool success */
        1:
          message.success = reader.bool();
          break;
        case /* string error_message */
        2:
          message.errorMessage = reader.string();
          break;
        case /* string file_system_snapshot_id */
        3:
          message.fileSystemSnapshotId = reader.string();
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler3.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.success !== false)
      writer.tag(1, WireType3.Varint).bool(message.success);
    if (message.errorMessage !== "")
      writer.tag(2, WireType3.LengthDelimited).string(message.errorMessage);
    if (message.fileSystemSnapshotId !== "")
      writer.tag(3, WireType3.LengthDelimited).string(message.fileSystemSnapshotId);
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler3.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var StopSandboxResponse = new StopSandboxResponse$Type();
var CreateFileSystemSnapshotRequest$Type = class extends MessageType3 {
  constructor() {
    super("coreweave.sandbox.v1beta2.CreateFileSystemSnapshotRequest", [
      { no: 1, name: "sandbox_id", kind: "scalar", T: 9, options: { "google.api.field_behavior": ["REQUIRED"] } },
      { no: 2, name: "idempotency_key", kind: "scalar", T: 9, options: { "google.api.field_behavior": ["OPTIONAL"] } },
      { no: 3, name: "wait_for_ready", kind: "scalar", opt: true, T: 8, options: { "google.api.field_behavior": ["OPTIONAL"] } },
      { no: 4, name: "max_timeout_seconds", kind: "scalar", opt: true, T: 5, options: { "google.api.field_behavior": ["OPTIONAL"] } }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.sandboxId = "";
    message.idempotencyKey = "";
    if (value !== void 0)
      reflectionMergePartial3(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* string sandbox_id */
        1:
          message.sandboxId = reader.string();
          break;
        case /* string idempotency_key */
        2:
          message.idempotencyKey = reader.string();
          break;
        case /* optional bool wait_for_ready */
        3:
          message.waitForReady = reader.bool();
          break;
        case /* optional int32 max_timeout_seconds */
        4:
          message.maxTimeoutSeconds = reader.int32();
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler3.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.sandboxId !== "")
      writer.tag(1, WireType3.LengthDelimited).string(message.sandboxId);
    if (message.idempotencyKey !== "")
      writer.tag(2, WireType3.LengthDelimited).string(message.idempotencyKey);
    if (message.waitForReady !== void 0)
      writer.tag(3, WireType3.Varint).bool(message.waitForReady);
    if (message.maxTimeoutSeconds !== void 0)
      writer.tag(4, WireType3.Varint).int32(message.maxTimeoutSeconds);
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler3.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var CreateFileSystemSnapshotRequest = new CreateFileSystemSnapshotRequest$Type();
var CreateFileSystemSnapshotResponse$Type = class extends MessageType3 {
  constructor() {
    super("coreweave.sandbox.v1beta2.CreateFileSystemSnapshotResponse", [
      {
        no: 1,
        name: "success",
        kind: "scalar",
        T: 8
        /*ScalarType.BOOL*/
      },
      {
        no: 2,
        name: "error_message",
        kind: "scalar",
        T: 9
        /*ScalarType.STRING*/
      },
      {
        no: 3,
        name: "file_system_snapshot_id",
        kind: "scalar",
        T: 9
        /*ScalarType.STRING*/
      }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.success = false;
    message.errorMessage = "";
    message.fileSystemSnapshotId = "";
    if (value !== void 0)
      reflectionMergePartial3(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* bool success */
        1:
          message.success = reader.bool();
          break;
        case /* string error_message */
        2:
          message.errorMessage = reader.string();
          break;
        case /* string file_system_snapshot_id */
        3:
          message.fileSystemSnapshotId = reader.string();
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler3.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.success !== false)
      writer.tag(1, WireType3.Varint).bool(message.success);
    if (message.errorMessage !== "")
      writer.tag(2, WireType3.LengthDelimited).string(message.errorMessage);
    if (message.fileSystemSnapshotId !== "")
      writer.tag(3, WireType3.LengthDelimited).string(message.fileSystemSnapshotId);
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler3.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var CreateFileSystemSnapshotResponse = new CreateFileSystemSnapshotResponse$Type();
var FileSystemSnapshot$Type = class extends MessageType3 {
  constructor() {
    super("coreweave.sandbox.v1beta2.FileSystemSnapshot", [
      {
        no: 1,
        name: "file_system_snapshot_id",
        kind: "scalar",
        T: 9
        /*ScalarType.STRING*/
      },
      { no: 2, name: "status", kind: "enum", T: () => ["coreweave.sandbox.v1beta2.FileSystemSnapshotStatus", FileSystemSnapshotStatus, "FILE_SYSTEM_SNAPSHOT_STATUS_"] },
      {
        no: 3,
        name: "status_reason",
        kind: "scalar",
        T: 9
        /*ScalarType.STRING*/
      },
      {
        no: 4,
        name: "size_bytes",
        kind: "scalar",
        T: 3
        /*ScalarType.INT64*/
      },
      { no: 5, name: "created_at", kind: "message", T: () => Timestamp },
      { no: 6, name: "updated_at", kind: "message", T: () => Timestamp },
      { no: 7, name: "completed_at", kind: "message", T: () => Timestamp },
      {
        no: 8,
        name: "source_sandbox_id",
        kind: "scalar",
        T: 9
        /*ScalarType.STRING*/
      },
      { no: 9, name: "trigger", kind: "enum", T: () => ["coreweave.sandbox.v1beta2.FileSystemSnapshotTrigger", FileSystemSnapshotTrigger, "FILE_SYSTEM_SNAPSHOT_TRIGGER_"] },
      {
        no: 10,
        name: "idempotency_key",
        kind: "scalar",
        T: 9
        /*ScalarType.STRING*/
      }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.fileSystemSnapshotId = "";
    message.status = 0;
    message.statusReason = "";
    message.sizeBytes = "0";
    message.sourceSandboxId = "";
    message.trigger = 0;
    message.idempotencyKey = "";
    if (value !== void 0)
      reflectionMergePartial3(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* string file_system_snapshot_id */
        1:
          message.fileSystemSnapshotId = reader.string();
          break;
        case /* coreweave.sandbox.v1beta2.FileSystemSnapshotStatus status */
        2:
          message.status = reader.int32();
          break;
        case /* string status_reason */
        3:
          message.statusReason = reader.string();
          break;
        case /* int64 size_bytes */
        4:
          message.sizeBytes = reader.int64().toString();
          break;
        case /* google.protobuf.Timestamp created_at */
        5:
          message.createdAt = Timestamp.internalBinaryRead(reader, reader.uint32(), options, message.createdAt);
          break;
        case /* google.protobuf.Timestamp updated_at */
        6:
          message.updatedAt = Timestamp.internalBinaryRead(reader, reader.uint32(), options, message.updatedAt);
          break;
        case /* google.protobuf.Timestamp completed_at */
        7:
          message.completedAt = Timestamp.internalBinaryRead(reader, reader.uint32(), options, message.completedAt);
          break;
        case /* string source_sandbox_id */
        8:
          message.sourceSandboxId = reader.string();
          break;
        case /* coreweave.sandbox.v1beta2.FileSystemSnapshotTrigger trigger */
        9:
          message.trigger = reader.int32();
          break;
        case /* string idempotency_key */
        10:
          message.idempotencyKey = reader.string();
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler3.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.fileSystemSnapshotId !== "")
      writer.tag(1, WireType3.LengthDelimited).string(message.fileSystemSnapshotId);
    if (message.status !== 0)
      writer.tag(2, WireType3.Varint).int32(message.status);
    if (message.statusReason !== "")
      writer.tag(3, WireType3.LengthDelimited).string(message.statusReason);
    if (message.sizeBytes !== "0")
      writer.tag(4, WireType3.Varint).int64(message.sizeBytes);
    if (message.createdAt)
      Timestamp.internalBinaryWrite(message.createdAt, writer.tag(5, WireType3.LengthDelimited).fork(), options).join();
    if (message.updatedAt)
      Timestamp.internalBinaryWrite(message.updatedAt, writer.tag(6, WireType3.LengthDelimited).fork(), options).join();
    if (message.completedAt)
      Timestamp.internalBinaryWrite(message.completedAt, writer.tag(7, WireType3.LengthDelimited).fork(), options).join();
    if (message.sourceSandboxId !== "")
      writer.tag(8, WireType3.LengthDelimited).string(message.sourceSandboxId);
    if (message.trigger !== 0)
      writer.tag(9, WireType3.Varint).int32(message.trigger);
    if (message.idempotencyKey !== "")
      writer.tag(10, WireType3.LengthDelimited).string(message.idempotencyKey);
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler3.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var FileSystemSnapshot = new FileSystemSnapshot$Type();
var GetFileSystemSnapshotRequest$Type = class extends MessageType3 {
  constructor() {
    super("coreweave.sandbox.v1beta2.GetFileSystemSnapshotRequest", [
      { no: 1, name: "file_system_snapshot_id", kind: "scalar", T: 9, options: { "google.api.field_behavior": ["REQUIRED"] } },
      { no: 2, name: "max_timeout_seconds", kind: "scalar", T: 5, options: { "google.api.field_behavior": ["OPTIONAL"] } }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.fileSystemSnapshotId = "";
    message.maxTimeoutSeconds = 0;
    if (value !== void 0)
      reflectionMergePartial3(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* string file_system_snapshot_id */
        1:
          message.fileSystemSnapshotId = reader.string();
          break;
        case /* int32 max_timeout_seconds */
        2:
          message.maxTimeoutSeconds = reader.int32();
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler3.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.fileSystemSnapshotId !== "")
      writer.tag(1, WireType3.LengthDelimited).string(message.fileSystemSnapshotId);
    if (message.maxTimeoutSeconds !== 0)
      writer.tag(2, WireType3.Varint).int32(message.maxTimeoutSeconds);
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler3.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var GetFileSystemSnapshotRequest = new GetFileSystemSnapshotRequest$Type();
var ListFileSystemSnapshotsRequest$Type = class extends MessageType3 {
  constructor() {
    super("coreweave.sandbox.v1beta2.ListFileSystemSnapshotsRequest", [
      { no: 1, name: "page_size", kind: "scalar", T: 5, options: { "google.api.field_behavior": ["OPTIONAL"] } },
      { no: 2, name: "page_token", kind: "scalar", T: 9, options: { "google.api.field_behavior": ["OPTIONAL"] } },
      { no: 3, name: "max_timeout_seconds", kind: "scalar", T: 5, options: { "google.api.field_behavior": ["OPTIONAL"] } }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.pageSize = 0;
    message.pageToken = "";
    message.maxTimeoutSeconds = 0;
    if (value !== void 0)
      reflectionMergePartial3(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* int32 page_size */
        1:
          message.pageSize = reader.int32();
          break;
        case /* string page_token */
        2:
          message.pageToken = reader.string();
          break;
        case /* int32 max_timeout_seconds */
        3:
          message.maxTimeoutSeconds = reader.int32();
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler3.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.pageSize !== 0)
      writer.tag(1, WireType3.Varint).int32(message.pageSize);
    if (message.pageToken !== "")
      writer.tag(2, WireType3.LengthDelimited).string(message.pageToken);
    if (message.maxTimeoutSeconds !== 0)
      writer.tag(3, WireType3.Varint).int32(message.maxTimeoutSeconds);
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler3.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var ListFileSystemSnapshotsRequest = new ListFileSystemSnapshotsRequest$Type();
var ListFileSystemSnapshotsResponse$Type = class extends MessageType3 {
  constructor() {
    super("coreweave.sandbox.v1beta2.ListFileSystemSnapshotsResponse", [
      { no: 1, name: "file_system_snapshots", kind: "message", repeat: 2, T: () => FileSystemSnapshot },
      {
        no: 2,
        name: "next_page_token",
        kind: "scalar",
        T: 9
        /*ScalarType.STRING*/
      }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.fileSystemSnapshots = [];
    message.nextPageToken = "";
    if (value !== void 0)
      reflectionMergePartial3(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* repeated coreweave.sandbox.v1beta2.FileSystemSnapshot file_system_snapshots */
        1:
          message.fileSystemSnapshots.push(FileSystemSnapshot.internalBinaryRead(reader, reader.uint32(), options));
          break;
        case /* string next_page_token */
        2:
          message.nextPageToken = reader.string();
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler3.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    for (let i = 0; i < message.fileSystemSnapshots.length; i++)
      FileSystemSnapshot.internalBinaryWrite(message.fileSystemSnapshots[i], writer.tag(1, WireType3.LengthDelimited).fork(), options).join();
    if (message.nextPageToken !== "")
      writer.tag(2, WireType3.LengthDelimited).string(message.nextPageToken);
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler3.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var ListFileSystemSnapshotsResponse = new ListFileSystemSnapshotsResponse$Type();
var DeleteFileSystemSnapshotRequest$Type = class extends MessageType3 {
  constructor() {
    super("coreweave.sandbox.v1beta2.DeleteFileSystemSnapshotRequest", [
      { no: 1, name: "file_system_snapshot_id", kind: "scalar", T: 9, options: { "google.api.field_behavior": ["REQUIRED"] } },
      { no: 2, name: "max_timeout_seconds", kind: "scalar", T: 5, options: { "google.api.field_behavior": ["OPTIONAL"] } }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.fileSystemSnapshotId = "";
    message.maxTimeoutSeconds = 0;
    if (value !== void 0)
      reflectionMergePartial3(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* string file_system_snapshot_id */
        1:
          message.fileSystemSnapshotId = reader.string();
          break;
        case /* int32 max_timeout_seconds */
        2:
          message.maxTimeoutSeconds = reader.int32();
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler3.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.fileSystemSnapshotId !== "")
      writer.tag(1, WireType3.LengthDelimited).string(message.fileSystemSnapshotId);
    if (message.maxTimeoutSeconds !== 0)
      writer.tag(2, WireType3.Varint).int32(message.maxTimeoutSeconds);
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler3.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var DeleteFileSystemSnapshotRequest = new DeleteFileSystemSnapshotRequest$Type();
var DeleteFileSystemSnapshotResponse$Type = class extends MessageType3 {
  constructor() {
    super("coreweave.sandbox.v1beta2.DeleteFileSystemSnapshotResponse", [
      {
        no: 1,
        name: "success",
        kind: "scalar",
        T: 8
        /*ScalarType.BOOL*/
      },
      {
        no: 2,
        name: "error_message",
        kind: "scalar",
        T: 9
        /*ScalarType.STRING*/
      }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.success = false;
    message.errorMessage = "";
    if (value !== void 0)
      reflectionMergePartial3(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* bool success */
        1:
          message.success = reader.bool();
          break;
        case /* string error_message */
        2:
          message.errorMessage = reader.string();
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler3.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.success !== false)
      writer.tag(1, WireType3.Varint).bool(message.success);
    if (message.errorMessage !== "")
      writer.tag(2, WireType3.LengthDelimited).string(message.errorMessage);
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler3.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var DeleteFileSystemSnapshotResponse = new DeleteFileSystemSnapshotResponse$Type();
var GetSandboxRequest$Type = class extends MessageType3 {
  constructor() {
    super("coreweave.sandbox.v1beta2.GetSandboxRequest", [
      { no: 1, name: "sandbox_id", kind: "scalar", T: 9, options: { "google.api.field_behavior": ["REQUIRED"] } },
      { no: 2, name: "max_timeout_seconds", kind: "scalar", T: 5, options: { "google.api.field_behavior": ["OPTIONAL"] } }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.sandboxId = "";
    message.maxTimeoutSeconds = 0;
    if (value !== void 0)
      reflectionMergePartial3(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* string sandbox_id */
        1:
          message.sandboxId = reader.string();
          break;
        case /* int32 max_timeout_seconds */
        2:
          message.maxTimeoutSeconds = reader.int32();
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler3.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.sandboxId !== "")
      writer.tag(1, WireType3.LengthDelimited).string(message.sandboxId);
    if (message.maxTimeoutSeconds !== 0)
      writer.tag(2, WireType3.Varint).int32(message.maxTimeoutSeconds);
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler3.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var GetSandboxRequest = new GetSandboxRequest$Type();
var GetSandboxResponse$Type = class extends MessageType3 {
  constructor() {
    super("coreweave.sandbox.v1beta2.GetSandboxResponse", [
      {
        no: 1,
        name: "sandbox_id",
        kind: "scalar",
        T: 9
        /*ScalarType.STRING*/
      },
      { no: 2, name: "started_at_time", kind: "message", T: () => Timestamp },
      { no: 3, name: "sandbox_status", kind: "enum", T: () => ["coreweave.sandbox.v1beta2.SandboxStatus", SandboxStatus, "SANDBOX_STATUS_"] },
      { no: 4, name: "current_resource_usage", kind: "message", T: () => ResourceUsage },
      {
        no: 5,
        name: "runner_id",
        kind: "scalar",
        T: 9
        /*ScalarType.STRING*/
      },
      {
        no: 6,
        name: "runner_group_id",
        kind: "scalar",
        T: 9
        /*ScalarType.STRING*/
      },
      {
        no: 7,
        name: "profile_id",
        kind: "scalar",
        T: 9
        /*ScalarType.STRING*/
      },
      {
        no: 8,
        name: "service_address",
        kind: "scalar",
        T: 9
        /*ScalarType.STRING*/
      },
      { no: 9, name: "exposed_ports", kind: "message", repeat: 2, T: () => Port },
      {
        no: 10,
        name: "applied_ingress_mode",
        kind: "scalar",
        T: 9
        /*ScalarType.STRING*/
      },
      {
        no: 11,
        name: "applied_egress_mode",
        kind: "scalar",
        T: 9
        /*ScalarType.STRING*/
      },
      {
        no: 12,
        name: "status_reason",
        kind: "scalar",
        T: 9
        /*ScalarType.STRING*/
      }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.sandboxId = "";
    message.sandboxStatus = 0;
    message.runnerId = "";
    message.runnerGroupId = "";
    message.profileId = "";
    message.serviceAddress = "";
    message.exposedPorts = [];
    message.appliedIngressMode = "";
    message.appliedEgressMode = "";
    message.statusReason = "";
    if (value !== void 0)
      reflectionMergePartial3(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* string sandbox_id */
        1:
          message.sandboxId = reader.string();
          break;
        case /* google.protobuf.Timestamp started_at_time */
        2:
          message.startedAtTime = Timestamp.internalBinaryRead(reader, reader.uint32(), options, message.startedAtTime);
          break;
        case /* coreweave.sandbox.v1beta2.SandboxStatus sandbox_status */
        3:
          message.sandboxStatus = reader.int32();
          break;
        case /* coreweave.sandbox.v1beta2.ResourceUsage current_resource_usage */
        4:
          message.currentResourceUsage = ResourceUsage.internalBinaryRead(reader, reader.uint32(), options, message.currentResourceUsage);
          break;
        case /* string runner_id */
        5:
          message.runnerId = reader.string();
          break;
        case /* string runner_group_id */
        6:
          message.runnerGroupId = reader.string();
          break;
        case /* string profile_id */
        7:
          message.profileId = reader.string();
          break;
        case /* string service_address */
        8:
          message.serviceAddress = reader.string();
          break;
        case /* repeated coreweave.sandbox.v1beta2.Port exposed_ports */
        9:
          message.exposedPorts.push(Port.internalBinaryRead(reader, reader.uint32(), options));
          break;
        case /* string applied_ingress_mode */
        10:
          message.appliedIngressMode = reader.string();
          break;
        case /* string applied_egress_mode */
        11:
          message.appliedEgressMode = reader.string();
          break;
        case /* string status_reason */
        12:
          message.statusReason = reader.string();
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler3.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.sandboxId !== "")
      writer.tag(1, WireType3.LengthDelimited).string(message.sandboxId);
    if (message.startedAtTime)
      Timestamp.internalBinaryWrite(message.startedAtTime, writer.tag(2, WireType3.LengthDelimited).fork(), options).join();
    if (message.sandboxStatus !== 0)
      writer.tag(3, WireType3.Varint).int32(message.sandboxStatus);
    if (message.currentResourceUsage)
      ResourceUsage.internalBinaryWrite(message.currentResourceUsage, writer.tag(4, WireType3.LengthDelimited).fork(), options).join();
    if (message.runnerId !== "")
      writer.tag(5, WireType3.LengthDelimited).string(message.runnerId);
    if (message.runnerGroupId !== "")
      writer.tag(6, WireType3.LengthDelimited).string(message.runnerGroupId);
    if (message.profileId !== "")
      writer.tag(7, WireType3.LengthDelimited).string(message.profileId);
    if (message.serviceAddress !== "")
      writer.tag(8, WireType3.LengthDelimited).string(message.serviceAddress);
    for (let i = 0; i < message.exposedPorts.length; i++)
      Port.internalBinaryWrite(message.exposedPorts[i], writer.tag(9, WireType3.LengthDelimited).fork(), options).join();
    if (message.appliedIngressMode !== "")
      writer.tag(10, WireType3.LengthDelimited).string(message.appliedIngressMode);
    if (message.appliedEgressMode !== "")
      writer.tag(11, WireType3.LengthDelimited).string(message.appliedEgressMode);
    if (message.statusReason !== "")
      writer.tag(12, WireType3.LengthDelimited).string(message.statusReason);
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler3.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var GetSandboxResponse = new GetSandboxResponse$Type();
var ListSandboxesRequest$Type = class extends MessageType3 {
  constructor() {
    super("coreweave.sandbox.v1beta2.ListSandboxesRequest", [
      { no: 1, name: "tags", kind: "scalar", repeat: 2, T: 9, options: { "google.api.field_behavior": ["OPTIONAL"] } },
      { no: 2, name: "status", kind: "enum", T: () => ["coreweave.sandbox.v1beta2.SandboxStatus", SandboxStatus, "SANDBOX_STATUS_"], options: { "google.api.field_behavior": ["OPTIONAL"] } },
      { no: 3, name: "profile_ids", kind: "scalar", repeat: 2, T: 9, options: { "google.api.field_behavior": ["OPTIONAL"] } },
      { no: 4, name: "runner_ids", kind: "scalar", repeat: 2, T: 9, options: { "google.api.field_behavior": ["OPTIONAL"] } },
      { no: 7, name: "profile_names", kind: "scalar", repeat: 2, T: 9, options: { "google.api.field_behavior": ["OPTIONAL"] } },
      { no: 5, name: "max_timeout_seconds", kind: "scalar", T: 5, options: { "google.api.field_behavior": ["OPTIONAL"] } },
      { no: 6, name: "include_stopped", kind: "scalar", T: 8, options: { "google.api.field_behavior": ["OPTIONAL"] } },
      { no: 8, name: "page_size", kind: "scalar", T: 5, options: { "google.api.field_behavior": ["OPTIONAL"] } },
      { no: 9, name: "page_token", kind: "scalar", T: 9, options: { "google.api.field_behavior": ["OPTIONAL"] } }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.tags = [];
    message.status = 0;
    message.profileIds = [];
    message.runnerIds = [];
    message.profileNames = [];
    message.maxTimeoutSeconds = 0;
    message.includeStopped = false;
    message.pageSize = 0;
    message.pageToken = "";
    if (value !== void 0)
      reflectionMergePartial3(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* repeated string tags */
        1:
          message.tags.push(reader.string());
          break;
        case /* coreweave.sandbox.v1beta2.SandboxStatus status */
        2:
          message.status = reader.int32();
          break;
        case /* repeated string profile_ids */
        3:
          message.profileIds.push(reader.string());
          break;
        case /* repeated string runner_ids */
        4:
          message.runnerIds.push(reader.string());
          break;
        case /* repeated string profile_names */
        7:
          message.profileNames.push(reader.string());
          break;
        case /* int32 max_timeout_seconds */
        5:
          message.maxTimeoutSeconds = reader.int32();
          break;
        case /* bool include_stopped */
        6:
          message.includeStopped = reader.bool();
          break;
        case /* int32 page_size */
        8:
          message.pageSize = reader.int32();
          break;
        case /* string page_token */
        9:
          message.pageToken = reader.string();
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler3.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    for (let i = 0; i < message.tags.length; i++)
      writer.tag(1, WireType3.LengthDelimited).string(message.tags[i]);
    if (message.status !== 0)
      writer.tag(2, WireType3.Varint).int32(message.status);
    for (let i = 0; i < message.profileIds.length; i++)
      writer.tag(3, WireType3.LengthDelimited).string(message.profileIds[i]);
    for (let i = 0; i < message.runnerIds.length; i++)
      writer.tag(4, WireType3.LengthDelimited).string(message.runnerIds[i]);
    if (message.maxTimeoutSeconds !== 0)
      writer.tag(5, WireType3.Varint).int32(message.maxTimeoutSeconds);
    if (message.includeStopped !== false)
      writer.tag(6, WireType3.Varint).bool(message.includeStopped);
    for (let i = 0; i < message.profileNames.length; i++)
      writer.tag(7, WireType3.LengthDelimited).string(message.profileNames[i]);
    if (message.pageSize !== 0)
      writer.tag(8, WireType3.Varint).int32(message.pageSize);
    if (message.pageToken !== "")
      writer.tag(9, WireType3.LengthDelimited).string(message.pageToken);
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler3.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var ListSandboxesRequest = new ListSandboxesRequest$Type();
var ListSandboxesResponse$Type = class extends MessageType3 {
  constructor() {
    super("coreweave.sandbox.v1beta2.ListSandboxesResponse", [
      { no: 1, name: "sandboxes", kind: "message", repeat: 2, T: () => SandboxInfo },
      {
        no: 2,
        name: "next_page_token",
        kind: "scalar",
        T: 9
        /*ScalarType.STRING*/
      }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.sandboxes = [];
    message.nextPageToken = "";
    if (value !== void 0)
      reflectionMergePartial3(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* repeated coreweave.sandbox.v1beta2.SandboxInfo sandboxes */
        1:
          message.sandboxes.push(SandboxInfo.internalBinaryRead(reader, reader.uint32(), options));
          break;
        case /* string next_page_token */
        2:
          message.nextPageToken = reader.string();
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler3.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    for (let i = 0; i < message.sandboxes.length; i++)
      SandboxInfo.internalBinaryWrite(message.sandboxes[i], writer.tag(1, WireType3.LengthDelimited).fork(), options).join();
    if (message.nextPageToken !== "")
      writer.tag(2, WireType3.LengthDelimited).string(message.nextPageToken);
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler3.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var ListSandboxesResponse = new ListSandboxesResponse$Type();
var SandboxInfo$Type = class extends MessageType3 {
  constructor() {
    super("coreweave.sandbox.v1beta2.SandboxInfo", [
      {
        no: 1,
        name: "sandbox_id",
        kind: "scalar",
        T: 9
        /*ScalarType.STRING*/
      },
      { no: 2, name: "started_at_time", kind: "message", T: () => Timestamp },
      { no: 3, name: "sandbox_status", kind: "enum", T: () => ["coreweave.sandbox.v1beta2.SandboxStatus", SandboxStatus, "SANDBOX_STATUS_"] },
      { no: 4, name: "current_resource_usage", kind: "message", T: () => ResourceUsage },
      {
        no: 5,
        name: "runner_id",
        kind: "scalar",
        T: 9
        /*ScalarType.STRING*/
      },
      {
        no: 6,
        name: "runner_group_id",
        kind: "scalar",
        T: 9
        /*ScalarType.STRING*/
      },
      {
        no: 7,
        name: "profile_id",
        kind: "scalar",
        T: 9
        /*ScalarType.STRING*/
      },
      {
        no: 8,
        name: "service_address",
        kind: "scalar",
        T: 9
        /*ScalarType.STRING*/
      },
      { no: 9, name: "exposed_ports", kind: "message", repeat: 2, T: () => Port },
      {
        no: 10,
        name: "applied_ingress_mode",
        kind: "scalar",
        T: 9
        /*ScalarType.STRING*/
      },
      {
        no: 11,
        name: "applied_egress_mode",
        kind: "scalar",
        T: 9
        /*ScalarType.STRING*/
      }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.sandboxId = "";
    message.sandboxStatus = 0;
    message.runnerId = "";
    message.runnerGroupId = "";
    message.profileId = "";
    message.serviceAddress = "";
    message.exposedPorts = [];
    message.appliedIngressMode = "";
    message.appliedEgressMode = "";
    if (value !== void 0)
      reflectionMergePartial3(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* string sandbox_id */
        1:
          message.sandboxId = reader.string();
          break;
        case /* google.protobuf.Timestamp started_at_time */
        2:
          message.startedAtTime = Timestamp.internalBinaryRead(reader, reader.uint32(), options, message.startedAtTime);
          break;
        case /* coreweave.sandbox.v1beta2.SandboxStatus sandbox_status */
        3:
          message.sandboxStatus = reader.int32();
          break;
        case /* coreweave.sandbox.v1beta2.ResourceUsage current_resource_usage */
        4:
          message.currentResourceUsage = ResourceUsage.internalBinaryRead(reader, reader.uint32(), options, message.currentResourceUsage);
          break;
        case /* string runner_id */
        5:
          message.runnerId = reader.string();
          break;
        case /* string runner_group_id */
        6:
          message.runnerGroupId = reader.string();
          break;
        case /* string profile_id */
        7:
          message.profileId = reader.string();
          break;
        case /* string service_address */
        8:
          message.serviceAddress = reader.string();
          break;
        case /* repeated coreweave.sandbox.v1beta2.Port exposed_ports */
        9:
          message.exposedPorts.push(Port.internalBinaryRead(reader, reader.uint32(), options));
          break;
        case /* string applied_ingress_mode */
        10:
          message.appliedIngressMode = reader.string();
          break;
        case /* string applied_egress_mode */
        11:
          message.appliedEgressMode = reader.string();
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler3.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.sandboxId !== "")
      writer.tag(1, WireType3.LengthDelimited).string(message.sandboxId);
    if (message.startedAtTime)
      Timestamp.internalBinaryWrite(message.startedAtTime, writer.tag(2, WireType3.LengthDelimited).fork(), options).join();
    if (message.sandboxStatus !== 0)
      writer.tag(3, WireType3.Varint).int32(message.sandboxStatus);
    if (message.currentResourceUsage)
      ResourceUsage.internalBinaryWrite(message.currentResourceUsage, writer.tag(4, WireType3.LengthDelimited).fork(), options).join();
    if (message.runnerId !== "")
      writer.tag(5, WireType3.LengthDelimited).string(message.runnerId);
    if (message.runnerGroupId !== "")
      writer.tag(6, WireType3.LengthDelimited).string(message.runnerGroupId);
    if (message.profileId !== "")
      writer.tag(7, WireType3.LengthDelimited).string(message.profileId);
    if (message.serviceAddress !== "")
      writer.tag(8, WireType3.LengthDelimited).string(message.serviceAddress);
    for (let i = 0; i < message.exposedPorts.length; i++)
      Port.internalBinaryWrite(message.exposedPorts[i], writer.tag(9, WireType3.LengthDelimited).fork(), options).join();
    if (message.appliedIngressMode !== "")
      writer.tag(10, WireType3.LengthDelimited).string(message.appliedIngressMode);
    if (message.appliedEgressMode !== "")
      writer.tag(11, WireType3.LengthDelimited).string(message.appliedEgressMode);
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler3.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var SandboxInfo = new SandboxInfo$Type();
var DeleteSandboxRequest$Type = class extends MessageType3 {
  constructor() {
    super("coreweave.sandbox.v1beta2.DeleteSandboxRequest", [
      { no: 1, name: "sandbox_id", kind: "scalar", T: 9, options: { "google.api.field_behavior": ["REQUIRED"] } },
      { no: 2, name: "max_timeout_seconds", kind: "scalar", T: 5, options: { "google.api.field_behavior": ["OPTIONAL"] } }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.sandboxId = "";
    message.maxTimeoutSeconds = 0;
    if (value !== void 0)
      reflectionMergePartial3(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* string sandbox_id */
        1:
          message.sandboxId = reader.string();
          break;
        case /* int32 max_timeout_seconds */
        2:
          message.maxTimeoutSeconds = reader.int32();
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler3.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.sandboxId !== "")
      writer.tag(1, WireType3.LengthDelimited).string(message.sandboxId);
    if (message.maxTimeoutSeconds !== 0)
      writer.tag(2, WireType3.Varint).int32(message.maxTimeoutSeconds);
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler3.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var DeleteSandboxRequest = new DeleteSandboxRequest$Type();
var DeleteSandboxResponse$Type = class extends MessageType3 {
  constructor() {
    super("coreweave.sandbox.v1beta2.DeleteSandboxResponse", [
      {
        no: 1,
        name: "success",
        kind: "scalar",
        T: 8
        /*ScalarType.BOOL*/
      },
      {
        no: 2,
        name: "error_message",
        kind: "scalar",
        T: 9
        /*ScalarType.STRING*/
      }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.success = false;
    message.errorMessage = "";
    if (value !== void 0)
      reflectionMergePartial3(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* bool success */
        1:
          message.success = reader.bool();
          break;
        case /* string error_message */
        2:
          message.errorMessage = reader.string();
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler3.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.success !== false)
      writer.tag(1, WireType3.Varint).bool(message.success);
    if (message.errorMessage !== "")
      writer.tag(2, WireType3.LengthDelimited).string(message.errorMessage);
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler3.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var DeleteSandboxResponse = new DeleteSandboxResponse$Type();
var ExecSandboxRequest$Type = class extends MessageType3 {
  constructor() {
    super("coreweave.sandbox.v1beta2.ExecSandboxRequest", [
      { no: 1, name: "sandbox_id", kind: "scalar", T: 9, options: { "google.api.field_behavior": ["REQUIRED"] } },
      { no: 2, name: "command", kind: "scalar", repeat: 2, T: 9, options: { "google.api.field_behavior": ["REQUIRED"] } },
      { no: 3, name: "args", kind: "scalar", repeat: 2, T: 9, options: { "google.api.field_behavior": ["OPTIONAL"] } },
      { no: 4, name: "max_timeout_seconds", kind: "scalar", T: 5, options: { "google.api.field_behavior": ["OPTIONAL"] } },
      { no: 5, name: "output_handling", kind: "enum", T: () => ["coreweave.sandbox.v1beta2.OutputPolicy", OutputPolicy, "OUTPUT_POLICY_"], options: { "google.api.field_behavior": ["OPTIONAL"] } },
      { no: 6, name: "buffered_max_kib", kind: "scalar", T: 13, options: { "google.api.field_behavior": ["OPTIONAL"] } }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.sandboxId = "";
    message.command = [];
    message.args = [];
    message.maxTimeoutSeconds = 0;
    message.outputHandling = 0;
    message.bufferedMaxKib = 0;
    if (value !== void 0)
      reflectionMergePartial3(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* string sandbox_id */
        1:
          message.sandboxId = reader.string();
          break;
        case /* repeated string command */
        2:
          message.command.push(reader.string());
          break;
        case /* repeated string args */
        3:
          message.args.push(reader.string());
          break;
        case /* int32 max_timeout_seconds */
        4:
          message.maxTimeoutSeconds = reader.int32();
          break;
        case /* coreweave.sandbox.v1beta2.OutputPolicy output_handling */
        5:
          message.outputHandling = reader.int32();
          break;
        case /* uint32 buffered_max_kib */
        6:
          message.bufferedMaxKib = reader.uint32();
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler3.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.sandboxId !== "")
      writer.tag(1, WireType3.LengthDelimited).string(message.sandboxId);
    for (let i = 0; i < message.command.length; i++)
      writer.tag(2, WireType3.LengthDelimited).string(message.command[i]);
    for (let i = 0; i < message.args.length; i++)
      writer.tag(3, WireType3.LengthDelimited).string(message.args[i]);
    if (message.maxTimeoutSeconds !== 0)
      writer.tag(4, WireType3.Varint).int32(message.maxTimeoutSeconds);
    if (message.outputHandling !== 0)
      writer.tag(5, WireType3.Varint).int32(message.outputHandling);
    if (message.bufferedMaxKib !== 0)
      writer.tag(6, WireType3.Varint).uint32(message.bufferedMaxKib);
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler3.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var ExecSandboxRequest = new ExecSandboxRequest$Type();
var ExecSandboxResponse$Type = class extends MessageType3 {
  constructor() {
    super("coreweave.sandbox.v1beta2.ExecSandboxResponse", [
      { no: 1, name: "result", kind: "message", T: () => ExecResponse }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    if (value !== void 0)
      reflectionMergePartial3(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* coreweave.sandbox.v1beta2.ExecResponse result */
        1:
          message.result = ExecResponse.internalBinaryRead(reader, reader.uint32(), options, message.result);
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler3.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.result)
      ExecResponse.internalBinaryWrite(message.result, writer.tag(1, WireType3.LengthDelimited).fork(), options).join();
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler3.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var ExecSandboxResponse = new ExecSandboxResponse$Type();
var AddFileSandboxRequest$Type = class extends MessageType3 {
  constructor() {
    super("coreweave.sandbox.v1beta2.AddFileSandboxRequest", [
      { no: 1, name: "sandbox_id", kind: "scalar", T: 9, options: { "google.api.field_behavior": ["REQUIRED"] } },
      { no: 2, name: "file_contents", kind: "scalar", T: 12, options: { "google.api.field_behavior": ["OPTIONAL"] } },
      { no: 3, name: "filepath", kind: "scalar", T: 9, options: { "google.api.field_behavior": ["REQUIRED"] } },
      { no: 4, name: "max_timeout_seconds", kind: "scalar", T: 5, options: { "google.api.field_behavior": ["OPTIONAL"] } }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.sandboxId = "";
    message.fileContents = new Uint8Array(0);
    message.filepath = "";
    message.maxTimeoutSeconds = 0;
    if (value !== void 0)
      reflectionMergePartial3(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* string sandbox_id */
        1:
          message.sandboxId = reader.string();
          break;
        case /* bytes file_contents */
        2:
          message.fileContents = reader.bytes();
          break;
        case /* string filepath */
        3:
          message.filepath = reader.string();
          break;
        case /* int32 max_timeout_seconds */
        4:
          message.maxTimeoutSeconds = reader.int32();
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler3.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.sandboxId !== "")
      writer.tag(1, WireType3.LengthDelimited).string(message.sandboxId);
    if (message.fileContents.length)
      writer.tag(2, WireType3.LengthDelimited).bytes(message.fileContents);
    if (message.filepath !== "")
      writer.tag(3, WireType3.LengthDelimited).string(message.filepath);
    if (message.maxTimeoutSeconds !== 0)
      writer.tag(4, WireType3.Varint).int32(message.maxTimeoutSeconds);
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler3.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var AddFileSandboxRequest = new AddFileSandboxRequest$Type();
var AddFileSandboxResponse$Type = class extends MessageType3 {
  constructor() {
    super("coreweave.sandbox.v1beta2.AddFileSandboxResponse", [
      {
        no: 1,
        name: "success",
        kind: "scalar",
        T: 8
        /*ScalarType.BOOL*/
      },
      {
        no: 2,
        name: "error_message",
        kind: "scalar",
        T: 9
        /*ScalarType.STRING*/
      }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.success = false;
    message.errorMessage = "";
    if (value !== void 0)
      reflectionMergePartial3(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* bool success */
        1:
          message.success = reader.bool();
          break;
        case /* string error_message */
        2:
          message.errorMessage = reader.string();
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler3.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.success !== false)
      writer.tag(1, WireType3.Varint).bool(message.success);
    if (message.errorMessage !== "")
      writer.tag(2, WireType3.LengthDelimited).string(message.errorMessage);
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler3.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var AddFileSandboxResponse = new AddFileSandboxResponse$Type();
var RetrieveFileSandboxRequest$Type = class extends MessageType3 {
  constructor() {
    super("coreweave.sandbox.v1beta2.RetrieveFileSandboxRequest", [
      { no: 1, name: "sandbox_id", kind: "scalar", T: 9, options: { "google.api.field_behavior": ["REQUIRED"] } },
      { no: 2, name: "filepath", kind: "scalar", T: 9, options: { "google.api.field_behavior": ["REQUIRED"] } },
      { no: 3, name: "max_timeout_seconds", kind: "scalar", T: 5, options: { "google.api.field_behavior": ["OPTIONAL"] } }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.sandboxId = "";
    message.filepath = "";
    message.maxTimeoutSeconds = 0;
    if (value !== void 0)
      reflectionMergePartial3(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* string sandbox_id */
        1:
          message.sandboxId = reader.string();
          break;
        case /* string filepath */
        2:
          message.filepath = reader.string();
          break;
        case /* int32 max_timeout_seconds */
        3:
          message.maxTimeoutSeconds = reader.int32();
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler3.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.sandboxId !== "")
      writer.tag(1, WireType3.LengthDelimited).string(message.sandboxId);
    if (message.filepath !== "")
      writer.tag(2, WireType3.LengthDelimited).string(message.filepath);
    if (message.maxTimeoutSeconds !== 0)
      writer.tag(3, WireType3.Varint).int32(message.maxTimeoutSeconds);
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler3.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var RetrieveFileSandboxRequest = new RetrieveFileSandboxRequest$Type();
var RetrieveFileSandboxResponse$Type = class extends MessageType3 {
  constructor() {
    super("coreweave.sandbox.v1beta2.RetrieveFileSandboxResponse", [
      {
        no: 1,
        name: "file_contents",
        kind: "scalar",
        T: 12
        /*ScalarType.BYTES*/
      },
      {
        no: 2,
        name: "success",
        kind: "scalar",
        T: 8
        /*ScalarType.BOOL*/
      },
      {
        no: 3,
        name: "error_message",
        kind: "scalar",
        T: 9
        /*ScalarType.STRING*/
      }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.fileContents = new Uint8Array(0);
    message.success = false;
    message.errorMessage = "";
    if (value !== void 0)
      reflectionMergePartial3(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* bytes file_contents */
        1:
          message.fileContents = reader.bytes();
          break;
        case /* bool success */
        2:
          message.success = reader.bool();
          break;
        case /* string error_message */
        3:
          message.errorMessage = reader.string();
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler3.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.fileContents.length)
      writer.tag(1, WireType3.LengthDelimited).bytes(message.fileContents);
    if (message.success !== false)
      writer.tag(2, WireType3.Varint).bool(message.success);
    if (message.errorMessage !== "")
      writer.tag(3, WireType3.LengthDelimited).string(message.errorMessage);
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler3.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var RetrieveFileSandboxResponse = new RetrieveFileSandboxResponse$Type();
var PauseSandboxRequest$Type = class extends MessageType3 {
  constructor() {
    super("coreweave.sandbox.v1beta2.PauseSandboxRequest", [
      { no: 1, name: "sandbox_id", kind: "scalar", T: 9, options: { "google.api.field_behavior": ["REQUIRED"] } },
      { no: 2, name: "max_timeout_seconds", kind: "scalar", T: 5, options: { "google.api.field_behavior": ["OPTIONAL"] } }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.sandboxId = "";
    message.maxTimeoutSeconds = 0;
    if (value !== void 0)
      reflectionMergePartial3(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* string sandbox_id */
        1:
          message.sandboxId = reader.string();
          break;
        case /* int32 max_timeout_seconds */
        2:
          message.maxTimeoutSeconds = reader.int32();
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler3.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.sandboxId !== "")
      writer.tag(1, WireType3.LengthDelimited).string(message.sandboxId);
    if (message.maxTimeoutSeconds !== 0)
      writer.tag(2, WireType3.Varint).int32(message.maxTimeoutSeconds);
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler3.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var PauseSandboxRequest = new PauseSandboxRequest$Type();
var PauseSandboxResponse$Type = class extends MessageType3 {
  constructor() {
    super("coreweave.sandbox.v1beta2.PauseSandboxResponse", [
      {
        no: 1,
        name: "success",
        kind: "scalar",
        T: 8
        /*ScalarType.BOOL*/
      },
      {
        no: 2,
        name: "error_message",
        kind: "scalar",
        T: 9
        /*ScalarType.STRING*/
      }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.success = false;
    message.errorMessage = "";
    if (value !== void 0)
      reflectionMergePartial3(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* bool success */
        1:
          message.success = reader.bool();
          break;
        case /* string error_message */
        2:
          message.errorMessage = reader.string();
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler3.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.success !== false)
      writer.tag(1, WireType3.Varint).bool(message.success);
    if (message.errorMessage !== "")
      writer.tag(2, WireType3.LengthDelimited).string(message.errorMessage);
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler3.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var PauseSandboxResponse = new PauseSandboxResponse$Type();
var ResumeSandboxRequest$Type = class extends MessageType3 {
  constructor() {
    super("coreweave.sandbox.v1beta2.ResumeSandboxRequest", [
      { no: 1, name: "sandbox_id", kind: "scalar", T: 9, options: { "google.api.field_behavior": ["REQUIRED"] } },
      { no: 2, name: "max_timeout_seconds", kind: "scalar", T: 5, options: { "google.api.field_behavior": ["OPTIONAL"] } }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.sandboxId = "";
    message.maxTimeoutSeconds = 0;
    if (value !== void 0)
      reflectionMergePartial3(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* string sandbox_id */
        1:
          message.sandboxId = reader.string();
          break;
        case /* int32 max_timeout_seconds */
        2:
          message.maxTimeoutSeconds = reader.int32();
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler3.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.sandboxId !== "")
      writer.tag(1, WireType3.LengthDelimited).string(message.sandboxId);
    if (message.maxTimeoutSeconds !== 0)
      writer.tag(2, WireType3.Varint).int32(message.maxTimeoutSeconds);
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler3.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var ResumeSandboxRequest = new ResumeSandboxRequest$Type();
var ResumeSandboxResponse$Type = class extends MessageType3 {
  constructor() {
    super("coreweave.sandbox.v1beta2.ResumeSandboxResponse", [
      {
        no: 1,
        name: "success",
        kind: "scalar",
        T: 8
        /*ScalarType.BOOL*/
      },
      {
        no: 2,
        name: "error_message",
        kind: "scalar",
        T: 9
        /*ScalarType.STRING*/
      }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.success = false;
    message.errorMessage = "";
    if (value !== void 0)
      reflectionMergePartial3(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* bool success */
        1:
          message.success = reader.bool();
          break;
        case /* string error_message */
        2:
          message.errorMessage = reader.string();
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler3.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.success !== false)
      writer.tag(1, WireType3.Varint).bool(message.success);
    if (message.errorMessage !== "")
      writer.tag(2, WireType3.LengthDelimited).string(message.errorMessage);
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler3.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var ResumeSandboxResponse = new ResumeSandboxResponse$Type();
var RawSandboxRequest$Type = class extends MessageType3 {
  constructor() {
    super("coreweave.sandbox.v1beta2.RawSandboxRequest", [
      { no: 1, name: "sandbox_id", kind: "scalar", T: 9, options: { "google.api.field_behavior": ["REQUIRED"] } },
      { no: 2, name: "action_type", kind: "enum", T: () => ["coreweave.sandbox.v1beta2.ActionType", ActionType, "ACTION_TYPE_"], options: { "google.api.field_behavior": ["REQUIRED"] } },
      { no: 3, name: "exec_payload", kind: "message", oneof: "actionPayload", T: () => ExecPayload },
      { no: 4, name: "add_file_payload", kind: "message", oneof: "actionPayload", T: () => AddFileSandboxRequest },
      { no: 5, name: "retrieve_file_payload", kind: "message", oneof: "actionPayload", T: () => RetrieveFileSandboxRequest },
      { no: 6, name: "max_timeout_seconds", kind: "scalar", T: 5, options: { "google.api.field_behavior": ["OPTIONAL"] } }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.sandboxId = "";
    message.actionType = 0;
    message.actionPayload = { oneofKind: void 0 };
    message.maxTimeoutSeconds = 0;
    if (value !== void 0)
      reflectionMergePartial3(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* string sandbox_id */
        1:
          message.sandboxId = reader.string();
          break;
        case /* coreweave.sandbox.v1beta2.ActionType action_type */
        2:
          message.actionType = reader.int32();
          break;
        case /* coreweave.sandbox.v1beta2.ExecPayload exec_payload */
        3:
          message.actionPayload = {
            oneofKind: "execPayload",
            execPayload: ExecPayload.internalBinaryRead(reader, reader.uint32(), options, message.actionPayload.execPayload)
          };
          break;
        case /* coreweave.sandbox.v1beta2.AddFileSandboxRequest add_file_payload */
        4:
          message.actionPayload = {
            oneofKind: "addFilePayload",
            addFilePayload: AddFileSandboxRequest.internalBinaryRead(reader, reader.uint32(), options, message.actionPayload.addFilePayload)
          };
          break;
        case /* coreweave.sandbox.v1beta2.RetrieveFileSandboxRequest retrieve_file_payload */
        5:
          message.actionPayload = {
            oneofKind: "retrieveFilePayload",
            retrieveFilePayload: RetrieveFileSandboxRequest.internalBinaryRead(reader, reader.uint32(), options, message.actionPayload.retrieveFilePayload)
          };
          break;
        case /* int32 max_timeout_seconds */
        6:
          message.maxTimeoutSeconds = reader.int32();
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler3.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.sandboxId !== "")
      writer.tag(1, WireType3.LengthDelimited).string(message.sandboxId);
    if (message.actionType !== 0)
      writer.tag(2, WireType3.Varint).int32(message.actionType);
    if (message.actionPayload.oneofKind === "execPayload")
      ExecPayload.internalBinaryWrite(message.actionPayload.execPayload, writer.tag(3, WireType3.LengthDelimited).fork(), options).join();
    if (message.actionPayload.oneofKind === "addFilePayload")
      AddFileSandboxRequest.internalBinaryWrite(message.actionPayload.addFilePayload, writer.tag(4, WireType3.LengthDelimited).fork(), options).join();
    if (message.actionPayload.oneofKind === "retrieveFilePayload")
      RetrieveFileSandboxRequest.internalBinaryWrite(message.actionPayload.retrieveFilePayload, writer.tag(5, WireType3.LengthDelimited).fork(), options).join();
    if (message.maxTimeoutSeconds !== 0)
      writer.tag(6, WireType3.Varint).int32(message.maxTimeoutSeconds);
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler3.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var RawSandboxRequest = new RawSandboxRequest$Type();
var RawSandboxResponse$Type = class extends MessageType3 {
  constructor() {
    super("coreweave.sandbox.v1beta2.RawSandboxResponse", [
      { no: 1, name: "action_type", kind: "enum", T: () => ["coreweave.sandbox.v1beta2.ActionType", ActionType, "ACTION_TYPE_"] },
      { no: 2, name: "exec_response", kind: "message", oneof: "actionResponse", T: () => ExecSandboxResponse },
      { no: 3, name: "add_file_response", kind: "message", oneof: "actionResponse", T: () => AddFileSandboxResponse },
      { no: 4, name: "retrieve_file_response", kind: "message", oneof: "actionResponse", T: () => RetrieveFileSandboxResponse }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.actionType = 0;
    message.actionResponse = { oneofKind: void 0 };
    if (value !== void 0)
      reflectionMergePartial3(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* coreweave.sandbox.v1beta2.ActionType action_type */
        1:
          message.actionType = reader.int32();
          break;
        case /* coreweave.sandbox.v1beta2.ExecSandboxResponse exec_response */
        2:
          message.actionResponse = {
            oneofKind: "execResponse",
            execResponse: ExecSandboxResponse.internalBinaryRead(reader, reader.uint32(), options, message.actionResponse.execResponse)
          };
          break;
        case /* coreweave.sandbox.v1beta2.AddFileSandboxResponse add_file_response */
        3:
          message.actionResponse = {
            oneofKind: "addFileResponse",
            addFileResponse: AddFileSandboxResponse.internalBinaryRead(reader, reader.uint32(), options, message.actionResponse.addFileResponse)
          };
          break;
        case /* coreweave.sandbox.v1beta2.RetrieveFileSandboxResponse retrieve_file_response */
        4:
          message.actionResponse = {
            oneofKind: "retrieveFileResponse",
            retrieveFileResponse: RetrieveFileSandboxResponse.internalBinaryRead(reader, reader.uint32(), options, message.actionResponse.retrieveFileResponse)
          };
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler3.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.actionType !== 0)
      writer.tag(1, WireType3.Varint).int32(message.actionType);
    if (message.actionResponse.oneofKind === "execResponse")
      ExecSandboxResponse.internalBinaryWrite(message.actionResponse.execResponse, writer.tag(2, WireType3.LengthDelimited).fork(), options).join();
    if (message.actionResponse.oneofKind === "addFileResponse")
      AddFileSandboxResponse.internalBinaryWrite(message.actionResponse.addFileResponse, writer.tag(3, WireType3.LengthDelimited).fork(), options).join();
    if (message.actionResponse.oneofKind === "retrieveFileResponse")
      RetrieveFileSandboxResponse.internalBinaryWrite(message.actionResponse.retrieveFileResponse, writer.tag(4, WireType3.LengthDelimited).fork(), options).join();
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler3.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var RawSandboxResponse = new RawSandboxResponse$Type();
var ObjectStorageWIFConfig$Type = class extends MessageType3 {
  constructor() {
    super("coreweave.sandbox.v1beta2.ObjectStorageWIFConfig", [
      { no: 1, name: "id", kind: "scalar", T: 9, options: { "google.api.field_behavior": ["OUTPUT_ONLY"] } },
      { no: 2, name: "wif_config_id", kind: "scalar", T: 9, options: { "google.api.field_behavior": ["REQUIRED"] } },
      {
        no: 3,
        name: "enabled",
        kind: "scalar",
        opt: true,
        T: 8
        /*ScalarType.BOOL*/
      },
      { no: 4, name: "allowed_buckets", kind: "scalar", repeat: 2, T: 9, options: { "google.api.field_behavior": ["OPTIONAL"] } },
      { no: 5, name: "max_permission", kind: "enum", T: () => ["coreweave.sandbox.v1beta2.ObjectStoragePermission", ObjectStoragePermission, "OBJECT_STORAGE_PERMISSION_"], options: { "google.api.field_behavior": ["REQUIRED"] } },
      { no: 6, name: "created_at", kind: "message", T: () => Timestamp, options: { "google.api.field_behavior": ["OUTPUT_ONLY"] } },
      { no: 7, name: "updated_at", kind: "message", T: () => Timestamp, options: { "google.api.field_behavior": ["OUTPUT_ONLY"] } }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.id = "";
    message.wifConfigId = "";
    message.allowedBuckets = [];
    message.maxPermission = 0;
    if (value !== void 0)
      reflectionMergePartial3(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* string id */
        1:
          message.id = reader.string();
          break;
        case /* string wif_config_id */
        2:
          message.wifConfigId = reader.string();
          break;
        case /* optional bool enabled */
        3:
          message.enabled = reader.bool();
          break;
        case /* repeated string allowed_buckets */
        4:
          message.allowedBuckets.push(reader.string());
          break;
        case /* coreweave.sandbox.v1beta2.ObjectStoragePermission max_permission */
        5:
          message.maxPermission = reader.int32();
          break;
        case /* google.protobuf.Timestamp created_at */
        6:
          message.createdAt = Timestamp.internalBinaryRead(reader, reader.uint32(), options, message.createdAt);
          break;
        case /* google.protobuf.Timestamp updated_at */
        7:
          message.updatedAt = Timestamp.internalBinaryRead(reader, reader.uint32(), options, message.updatedAt);
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler3.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.id !== "")
      writer.tag(1, WireType3.LengthDelimited).string(message.id);
    if (message.wifConfigId !== "")
      writer.tag(2, WireType3.LengthDelimited).string(message.wifConfigId);
    if (message.enabled !== void 0)
      writer.tag(3, WireType3.Varint).bool(message.enabled);
    for (let i = 0; i < message.allowedBuckets.length; i++)
      writer.tag(4, WireType3.LengthDelimited).string(message.allowedBuckets[i]);
    if (message.maxPermission !== 0)
      writer.tag(5, WireType3.Varint).int32(message.maxPermission);
    if (message.createdAt)
      Timestamp.internalBinaryWrite(message.createdAt, writer.tag(6, WireType3.LengthDelimited).fork(), options).join();
    if (message.updatedAt)
      Timestamp.internalBinaryWrite(message.updatedAt, writer.tag(7, WireType3.LengthDelimited).fork(), options).join();
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler3.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var ObjectStorageWIFConfig = new ObjectStorageWIFConfig$Type();
var GetObjectStorageWIFConfigRequest$Type = class extends MessageType3 {
  constructor() {
    super("coreweave.sandbox.v1beta2.GetObjectStorageWIFConfigRequest", []);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    if (value !== void 0)
      reflectionMergePartial3(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler3.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler3.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var GetObjectStorageWIFConfigRequest = new GetObjectStorageWIFConfigRequest$Type();
var SetObjectStorageWIFConfigRequest$Type = class extends MessageType3 {
  constructor() {
    super("coreweave.sandbox.v1beta2.SetObjectStorageWIFConfigRequest", [
      { no: 1, name: "wif_config_id", kind: "scalar", T: 9, options: { "google.api.field_behavior": ["REQUIRED"] } },
      {
        no: 2,
        name: "enabled",
        kind: "scalar",
        opt: true,
        T: 8
        /*ScalarType.BOOL*/
      },
      { no: 3, name: "allowed_buckets", kind: "scalar", repeat: 2, T: 9, options: { "google.api.field_behavior": ["OPTIONAL"] } },
      { no: 4, name: "max_permission", kind: "enum", T: () => ["coreweave.sandbox.v1beta2.ObjectStoragePermission", ObjectStoragePermission, "OBJECT_STORAGE_PERMISSION_"], options: { "google.api.field_behavior": ["REQUIRED"] } }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.wifConfigId = "";
    message.allowedBuckets = [];
    message.maxPermission = 0;
    if (value !== void 0)
      reflectionMergePartial3(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* string wif_config_id */
        1:
          message.wifConfigId = reader.string();
          break;
        case /* optional bool enabled */
        2:
          message.enabled = reader.bool();
          break;
        case /* repeated string allowed_buckets */
        3:
          message.allowedBuckets.push(reader.string());
          break;
        case /* coreweave.sandbox.v1beta2.ObjectStoragePermission max_permission */
        4:
          message.maxPermission = reader.int32();
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler3.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.wifConfigId !== "")
      writer.tag(1, WireType3.LengthDelimited).string(message.wifConfigId);
    if (message.enabled !== void 0)
      writer.tag(2, WireType3.Varint).bool(message.enabled);
    for (let i = 0; i < message.allowedBuckets.length; i++)
      writer.tag(3, WireType3.LengthDelimited).string(message.allowedBuckets[i]);
    if (message.maxPermission !== 0)
      writer.tag(4, WireType3.Varint).int32(message.maxPermission);
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler3.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var SetObjectStorageWIFConfigRequest = new SetObjectStorageWIFConfigRequest$Type();
var DeleteObjectStorageWIFConfigRequest$Type = class extends MessageType3 {
  constructor() {
    super("coreweave.sandbox.v1beta2.DeleteObjectStorageWIFConfigRequest", []);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    if (value !== void 0)
      reflectionMergePartial3(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler3.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler3.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var DeleteObjectStorageWIFConfigRequest = new DeleteObjectStorageWIFConfigRequest$Type();
var DeleteObjectStorageWIFConfigResponse$Type = class extends MessageType3 {
  constructor() {
    super("coreweave.sandbox.v1beta2.DeleteObjectStorageWIFConfigResponse", []);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    if (value !== void 0)
      reflectionMergePartial3(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler3.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler3.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var DeleteObjectStorageWIFConfigResponse = new DeleteObjectStorageWIFConfigResponse$Type();
var GatewayService = new ServiceType2("coreweave.sandbox.v1beta2.GatewayService", [
  { name: "Start", options: { "google.api.http": { post: "/v1beta2/sandboxes", body: "*" } }, I: StartSandboxRequest, O: StartSandboxResponse },
  { name: "Stop", options: { "google.api.http": { post: "/v1beta2/sandboxes/{sandbox_id}/stop", body: "*" } }, I: StopSandboxRequest, O: StopSandboxResponse },
  { name: "CreateFileSystemSnapshot", options: { "google.api.http": { post: "/v1beta2/sandboxes/{sandbox_id}/file-system-snapshots", body: "*" } }, I: CreateFileSystemSnapshotRequest, O: CreateFileSystemSnapshotResponse },
  { name: "GetFileSystemSnapshot", options: { "google.api.http": { get: "/v1beta2/file-system-snapshots/{file_system_snapshot_id}" } }, I: GetFileSystemSnapshotRequest, O: FileSystemSnapshot },
  { name: "ListFileSystemSnapshots", options: { "google.api.http": { get: "/v1beta2/file-system-snapshots" } }, I: ListFileSystemSnapshotsRequest, O: ListFileSystemSnapshotsResponse },
  { name: "DeleteFileSystemSnapshot", options: { "google.api.http": { delete: "/v1beta2/file-system-snapshots/{file_system_snapshot_id}" } }, I: DeleteFileSystemSnapshotRequest, O: DeleteFileSystemSnapshotResponse },
  { name: "Get", options: { "google.api.http": { get: "/v1beta2/sandboxes/{sandbox_id}" } }, I: GetSandboxRequest, O: GetSandboxResponse },
  { name: "List", options: { "google.api.http": { get: "/v1beta2/sandboxes" } }, I: ListSandboxesRequest, O: ListSandboxesResponse },
  { name: "Delete", options: { "google.api.http": { delete: "/v1beta2/sandboxes/{sandbox_id}" } }, I: DeleteSandboxRequest, O: DeleteSandboxResponse },
  { name: "Exec", options: { "google.api.http": { post: "/v1beta2/sandboxes/{sandbox_id}/exec", body: "*" } }, I: ExecSandboxRequest, O: ExecSandboxResponse },
  { name: "AddFile", options: { "google.api.http": { post: "/v1beta2/sandboxes/{sandbox_id}/files", body: "*" } }, I: AddFileSandboxRequest, O: AddFileSandboxResponse },
  { name: "RetrieveFile", options: { "google.api.http": { get: "/v1beta2/sandboxes/{sandbox_id}/files/{filepath}" } }, I: RetrieveFileSandboxRequest, O: RetrieveFileSandboxResponse },
  { name: "Pause", options: { "google.api.http": { post: "/v1beta2/sandboxes/{sandbox_id}/pause", body: "*" } }, I: PauseSandboxRequest, O: PauseSandboxResponse },
  { name: "Resume", options: { "google.api.http": { post: "/v1beta2/sandboxes/{sandbox_id}/resume", body: "*" } }, I: ResumeSandboxRequest, O: ResumeSandboxResponse },
  { name: "Raw", options: { "google.api.http": { post: "/v1beta2/sandboxes/{sandbox_id}/raw", body: "*" } }, I: RawSandboxRequest, O: RawSandboxResponse },
  { name: "GetObjectStorageWIFConfig", options: { "google.api.http": { get: "/v1beta2/object-storage/wif-config" } }, I: GetObjectStorageWIFConfigRequest, O: ObjectStorageWIFConfig },
  { name: "SetObjectStorageWIFConfig", options: { "google.api.http": { put: "/v1beta2/object-storage/wif-config", body: "*" } }, I: SetObjectStorageWIFConfigRequest, O: ObjectStorageWIFConfig },
  { name: "DeleteObjectStorageWIFConfig", options: { "google.api.http": { delete: "/v1beta2/object-storage/wif-config" } }, I: DeleteObjectStorageWIFConfigRequest, O: DeleteObjectStorageWIFConfigResponse }
]);

// src/node/mappers.ts
var textDecoder = new TextDecoder();
var DEFAULT_CONTAINER_IMAGE = "python:3.11";
function commandName(command) {
  return command[0];
}
function commandArgs(command) {
  return command.slice(1);
}
function timeoutMsToSeconds(timeoutMs) {
  return timeoutMs === void 0 ? 0 : Math.ceil(timeoutMs / 1e3);
}
function toProtoStartRequest(request) {
  return {
    args: commandArgs(request.command),
    command: commandName(request.command),
    containerImage: request.containerImage ?? DEFAULT_CONTAINER_IMAGE,
    ...toProtoStartMetadata(request),
    ...toProtoResources(request.resources),
    ...toProtoStartFiles(request),
    ...toProtoStartNetwork(request),
    ...toProtoStartPlacement(request),
    runnerClusterSecrets: [],
    secretStores: []
  };
}
function toProtoStartMetadata(request) {
  return {
    environmentVariables: { ...request.environmentVariables },
    maxLifetimeSeconds: request.maxLifetimeSeconds ?? 0,
    maxTimeoutSeconds: timeoutMsToSeconds(request.timeoutMs),
    ...request.objectStorageAccess === void 0 ? {} : {
      objectStorageAccess: {
        buckets: [...request.objectStorageAccess.buckets],
        permission: request.objectStorageAccess.permission === "read" ? 1 : 2
      }
    },
    podAnnotations: { ...request.annotations },
    tags: [...request.tags ?? []]
  };
}
function toProtoStartFiles(request) {
  return {
    mountedFiles: toProtoMountedFiles(request.mountedFiles)
  };
}
function toProtoStartNetwork(request) {
  return {
    ...request.network === void 0 ? {} : { network: toProtoNetworkOptions(request.network) },
    ports: toProtoPorts(request.ports)
  };
}
function toProtoStartPlacement(request) {
  return {
    profileIds: [...request.profileIds ?? []],
    profileNames: [...request.profileNames ?? []],
    runnerIds: [...request.runnerIds ?? []]
  };
}
function toProtoPorts(ports) {
  return normalizePorts(ports).map((port) => ({
    containerPort: port.port,
    name: port.name ?? "",
    protocol: port.protocol ?? ""
  }));
}
function toProtoNetworkOptions(network) {
  return {
    egressMode: network.egressMode ?? "",
    exposedPorts: [...network.exposedPorts ?? []],
    ingressMode: network.ingressMode ?? ""
  };
}
function toProtoResources(resources) {
  if (resources === void 0) {
    return {};
  }
  if (isAdvancedResources(resources)) {
    return {
      resourceLimits: toProtoResourceSpec(resources.limits),
      resourceRequests: toProtoResourceSpec(resources.requests)
    };
  }
  return {
    resources: toProtoResourceSpec(resources)
  };
}
function toProtoResourceSpec(spec) {
  return {
    cpu: spec.cpu ?? "",
    memory: spec.memory ?? ""
  };
}
function toProtoMountedFiles(mountedFiles) {
  return normalizeMountedFiles(mountedFiles).map((file) => ({
    fileContent: normalizeFileContent(file.content),
    mountPath: file.path
  }));
}
function toProtoExecRequest(request) {
  return {
    args: [],
    bufferedMaxKib: request.bufferedMaxKiB ?? 0,
    command: toExecCommand(request),
    maxTimeoutSeconds: timeoutMsToSeconds(request.timeoutMs),
    outputHandling: request.bufferedMaxKiB === void 0 ? 0 /* UNSPECIFIED */ : 1 /* BUFFERED */,
    sandboxId: request.sandboxId
  };
}
function toProtoListSandboxesRequest(request) {
  return {
    includeStopped: request.includeStopped ?? false,
    maxTimeoutSeconds: timeoutMsToSeconds(request.timeoutMs),
    pageSize: request.pageSize ?? 0,
    pageToken: request.pageToken ?? "",
    profileIds: [...request.profileIds ?? []],
    profileNames: [...request.profileNames ?? []],
    runnerIds: [...request.runnerIds ?? []],
    status: toProtoSandboxStatus(request.status),
    tags: [...request.tags ?? []]
  };
}
function toSdkProcessResult(command, response) {
  return {
    command,
    exitCode: response.exitCode,
    failed: response.exitCode !== 0,
    ok: response.exitCode === 0,
    stderr: textDecoder.decode(response.stderr),
    stderrBytes: response.stderr,
    stderrBytesProduced: toByteCount(response.stderrBytesProduced, response.stderr),
    stderrTruncated: response.stderrTruncated,
    stdout: textDecoder.decode(response.stdout),
    stdoutBytes: response.stdout,
    stdoutBytesProduced: toByteCount(response.stdoutBytesProduced, response.stdout),
    stdoutTruncated: response.stdoutTruncated
  };
}
function toSdkListSandboxesResult(response) {
  return {
    ...response.nextPageToken === "" ? {} : { nextPageToken: response.nextPageToken },
    sandboxes: response.sandboxes.map(toSdkSandboxInfo)
  };
}
function toSdkSandboxInfo(info) {
  return {
    ...info.profileId === "" ? {} : { profileId: info.profileId },
    ...info.runnerGroupId === "" ? {} : { runnerGroupId: info.runnerGroupId },
    ...info.runnerId === "" ? {} : { runnerId: info.runnerId },
    sandboxId: info.sandboxId,
    status: toSdkSandboxStatus(info.sandboxStatus)
  };
}
function toSdkSandboxStatus(status) {
  switch (status) {
    case 6 /* PENDING */:
      return "pending";
    case 1 /* CREATING */:
      return "creating";
    case 2 /* RUNNING */:
      return "running";
    case 7 /* PAUSED */:
      return "paused";
    case 9 /* TERMINATING */:
      return "terminating";
    case 3 /* COMPLETED */:
      return "completed";
    case 4 /* FAILED */:
      return "failed";
    case 5 /* TERMINATED */:
      return "terminated";
    case 0 /* UNSPECIFIED */:
      return "unspecified";
    default: {
      const _exhaustiveCheck = status;
      throw new Error(`Unhandled sandbox status: ${_exhaustiveCheck}`);
    }
  }
}
function toProtoSandboxStatus(status) {
  switch (status) {
    case void 0:
    case "unspecified":
      return 0 /* UNSPECIFIED */;
    case "pending":
      return 6 /* PENDING */;
    case "creating":
      return 1 /* CREATING */;
    case "running":
      return 2 /* RUNNING */;
    case "paused":
      return 7 /* PAUSED */;
    case "terminating":
      return 9 /* TERMINATING */;
    case "completed":
      return 3 /* COMPLETED */;
    case "failed":
      return 4 /* FAILED */;
    case "terminated":
      return 5 /* TERMINATED */;
    default: {
      const _exhaustiveCheck = status;
      throw new Error(`Unhandled sandbox status: ${_exhaustiveCheck}`);
    }
  }
}
function toExecCommand(request) {
  return commandForWorkingDirectory(request.command, request.cwd);
}
function toByteCount(value, fallback) {
  if (value === "") {
    return fallback.byteLength;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback.byteLength;
  }
  return parsed === 0 && fallback.byteLength > 0 ? fallback.byteLength : parsed;
}

// src/node/grpc-channel.ts
import { ChannelCredentials } from "@grpc/grpc-js";
import { GrpcTransport } from "@protobuf-ts/grpc-transport";

// src/node/generated/coreweave/sandbox/v1beta2/gateway.client.ts
import { stackIntercept } from "@protobuf-ts/runtime-rpc";
var GatewayServiceClient = class {
  constructor(_transport) {
    this._transport = _transport;
  }
  _transport;
  typeName = GatewayService.typeName;
  methods = GatewayService.methods;
  options = GatewayService.options;
  /**
   * Start launches a new sandbox.
   *
   * @generated from protobuf rpc: Start
   */
  start(input, options) {
    const method = this.methods[0], opt = this._transport.mergeOptions(options);
    return stackIntercept("unary", this._transport, method, opt, input);
  }
  /**
   * Stop terminates a running sandbox.
   *
   * @generated from protobuf rpc: Stop
   */
  stop(input, options) {
    const method = this.methods[1], opt = this._transport.mergeOptions(options);
    return stackIntercept("unary", this._transport, method, opt, input);
  }
  /**
   * CreateFileSystemSnapshot creates an FSS from a running sandbox without stopping it.
   *
   * @generated from protobuf rpc: CreateFileSystemSnapshot
   */
  createFileSystemSnapshot(input, options) {
    const method = this.methods[2], opt = this._transport.mergeOptions(options);
    return stackIntercept("unary", this._transport, method, opt, input);
  }
  /**
   * GetFileSystemSnapshot retrieves an org-scoped FSS by id.
   *
   * @generated from protobuf rpc: GetFileSystemSnapshot
   */
  getFileSystemSnapshot(input, options) {
    const method = this.methods[3], opt = this._transport.mergeOptions(options);
    return stackIntercept("unary", this._transport, method, opt, input);
  }
  /**
   * ListFileSystemSnapshots lists org-scoped FSS rows.
   *
   * @generated from protobuf rpc: ListFileSystemSnapshots
   */
  listFileSystemSnapshots(input, options) {
    const method = this.methods[4], opt = this._transport.mergeOptions(options);
    return stackIntercept("unary", this._transport, method, opt, input);
  }
  /**
   * DeleteFileSystemSnapshot hides an FSS row from future customer Get/List calls.
   *
   * @generated from protobuf rpc: DeleteFileSystemSnapshot
   */
  deleteFileSystemSnapshot(input, options) {
    const method = this.methods[5], opt = this._transport.mergeOptions(options);
    return stackIntercept("unary", this._transport, method, opt, input);
  }
  /**
   * Get retrieves details about a specific sandbox.
   *
   * @generated from protobuf rpc: Get
   */
  get(input, options) {
    const method = this.methods[6], opt = this._transport.mergeOptions(options);
    return stackIntercept("unary", this._transport, method, opt, input);
  }
  /**
   * List enumerates sandboxes with optional filters.
   *
   * @generated from protobuf rpc: List
   */
  list(input, options) {
    const method = this.methods[7], opt = this._transport.mergeOptions(options);
    return stackIntercept("unary", this._transport, method, opt, input);
  }
  /**
   * Delete removes a sandbox.
   *
   * @generated from protobuf rpc: Delete
   */
  delete(input, options) {
    const method = this.methods[8], opt = this._transport.mergeOptions(options);
    return stackIntercept("unary", this._transport, method, opt, input);
  }
  /**
   * Exec executes a command within a sandbox.
   *
   * @generated from protobuf rpc: Exec
   */
  exec(input, options) {
    const method = this.methods[9], opt = this._transport.mergeOptions(options);
    return stackIntercept("unary", this._transport, method, opt, input);
  }
  /**
   * AddFile writes (or overwrites) a file inside the sandbox filesystem.
   *
   * @generated from protobuf rpc: AddFile
   */
  addFile(input, options) {
    const method = this.methods[10], opt = this._transport.mergeOptions(options);
    return stackIntercept("unary", this._transport, method, opt, input);
  }
  /**
   * RetrieveFile retrieves a file's contents from the sandbox.
   *
   * @generated from protobuf rpc: RetrieveFile
   */
  retrieveFile(input, options) {
    const method = this.methods[11], opt = this._transport.mergeOptions(options);
    return stackIntercept("unary", this._transport, method, opt, input);
  }
  /**
   * Pause pauses a running sandbox.
   *
   * @generated from protobuf rpc: Pause
   */
  pause(input, options) {
    const method = this.methods[12], opt = this._transport.mergeOptions(options);
    return stackIntercept("unary", this._transport, method, opt, input);
  }
  /**
   * Resume resumes a paused sandbox.
   *
   * @generated from protobuf rpc: Resume
   */
  resume(input, options) {
    const method = this.methods[13], opt = this._transport.mergeOptions(options);
    return stackIntercept("unary", this._transport, method, opt, input);
  }
  /**
   * Raw executes a raw action on a sandbox based on action_type.
   *
   * @generated from protobuf rpc: Raw
   */
  raw(input, options) {
    const method = this.methods[14], opt = this._transport.mergeOptions(options);
    return stackIntercept("unary", this._transport, method, opt, input);
  }
  // --- Object Storage WIF Config Management ---
  /**
   * Returns the organization's WIF configuration.
   * Derives org_id from the authenticated caller.
   *
   * @generated from protobuf rpc: GetObjectStorageWIFConfig
   */
  getObjectStorageWIFConfig(input, options) {
    const method = this.methods[15], opt = this._transport.mergeOptions(options);
    return stackIntercept("unary", this._transport, method, opt, input);
  }
  /**
   * Creates or replaces the organization's WIF configuration.
   * Derives org_id from the authenticated caller.
   * Since there is one config per org, this is an idempotent upsert.
   *
   * @generated from protobuf rpc: SetObjectStorageWIFConfig
   */
  setObjectStorageWIFConfig(input, options) {
    const method = this.methods[16], opt = this._transport.mergeOptions(options);
    return stackIntercept("unary", this._transport, method, opt, input);
  }
  /**
   * Deletes the organization's WIF configuration.
   * Running sandboxes are unaffected until their OIDC JWT expires.
   * New sandbox requests with object_storage_access will be rejected.
   *
   * @generated from protobuf rpc: DeleteObjectStorageWIFConfig
   */
  deleteObjectStorageWIFConfig(input, options) {
    const method = this.methods[17], opt = this._transport.mergeOptions(options);
    return stackIntercept("unary", this._transport, method, opt, input);
  }
};

// src/node/generated/coreweave/sandbox/v1beta2/streaming.ts
import { ServiceType as ServiceType3 } from "@protobuf-ts/runtime-rpc";
import { WireType as WireType4 } from "@protobuf-ts/runtime";
import { UnknownFieldHandler as UnknownFieldHandler4 } from "@protobuf-ts/runtime";
import { reflectionMergePartial as reflectionMergePartial4 } from "@protobuf-ts/runtime";
import { MessageType as MessageType4 } from "@protobuf-ts/runtime";
var ExecStreamOutput_StreamType = /* @__PURE__ */ ((ExecStreamOutput_StreamType2) => {
  ExecStreamOutput_StreamType2[ExecStreamOutput_StreamType2["UNSPECIFIED"] = 0] = "UNSPECIFIED";
  ExecStreamOutput_StreamType2[ExecStreamOutput_StreamType2["STDOUT"] = 1] = "STDOUT";
  ExecStreamOutput_StreamType2[ExecStreamOutput_StreamType2["STDERR"] = 2] = "STDERR";
  return ExecStreamOutput_StreamType2;
})(ExecStreamOutput_StreamType || {});
var ExecStreamRequest$Type = class extends MessageType4 {
  constructor() {
    super("coreweave.sandbox.v1beta2.ExecStreamRequest", [
      { no: 1, name: "init", kind: "message", oneof: "request", T: () => ExecStreamInit },
      { no: 2, name: "stdin", kind: "message", oneof: "request", T: () => ExecStreamData },
      { no: 3, name: "resize", kind: "message", oneof: "request", T: () => ExecStreamResize },
      { no: 4, name: "close", kind: "message", oneof: "request", T: () => ExecStreamClose }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.request = { oneofKind: void 0 };
    if (value !== void 0)
      reflectionMergePartial4(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* coreweave.sandbox.v1beta2.ExecStreamInit init */
        1:
          message.request = {
            oneofKind: "init",
            init: ExecStreamInit.internalBinaryRead(reader, reader.uint32(), options, message.request.init)
          };
          break;
        case /* coreweave.sandbox.v1beta2.ExecStreamData stdin */
        2:
          message.request = {
            oneofKind: "stdin",
            stdin: ExecStreamData.internalBinaryRead(reader, reader.uint32(), options, message.request.stdin)
          };
          break;
        case /* coreweave.sandbox.v1beta2.ExecStreamResize resize */
        3:
          message.request = {
            oneofKind: "resize",
            resize: ExecStreamResize.internalBinaryRead(reader, reader.uint32(), options, message.request.resize)
          };
          break;
        case /* coreweave.sandbox.v1beta2.ExecStreamClose close */
        4:
          message.request = {
            oneofKind: "close",
            close: ExecStreamClose.internalBinaryRead(reader, reader.uint32(), options, message.request.close)
          };
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler4.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.request.oneofKind === "init")
      ExecStreamInit.internalBinaryWrite(message.request.init, writer.tag(1, WireType4.LengthDelimited).fork(), options).join();
    if (message.request.oneofKind === "stdin")
      ExecStreamData.internalBinaryWrite(message.request.stdin, writer.tag(2, WireType4.LengthDelimited).fork(), options).join();
    if (message.request.oneofKind === "resize")
      ExecStreamResize.internalBinaryWrite(message.request.resize, writer.tag(3, WireType4.LengthDelimited).fork(), options).join();
    if (message.request.oneofKind === "close")
      ExecStreamClose.internalBinaryWrite(message.request.close, writer.tag(4, WireType4.LengthDelimited).fork(), options).join();
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler4.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var ExecStreamRequest = new ExecStreamRequest$Type();
var ExecStreamInit$Type = class extends MessageType4 {
  constructor() {
    super("coreweave.sandbox.v1beta2.ExecStreamInit", [
      { no: 1, name: "sandbox_id", kind: "scalar", T: 9, options: { "google.api.field_behavior": ["REQUIRED"] } },
      { no: 2, name: "command", kind: "scalar", repeat: 2, T: 9, options: { "google.api.field_behavior": ["REQUIRED"] } },
      { no: 3, name: "tty", kind: "scalar", T: 8, options: { "google.api.field_behavior": ["OPTIONAL"] } },
      { no: 4, name: "tty_width", kind: "scalar", T: 13, options: { "google.api.field_behavior": ["OPTIONAL"] } },
      { no: 5, name: "tty_height", kind: "scalar", T: 13, options: { "google.api.field_behavior": ["OPTIONAL"] } },
      { no: 6, name: "env", kind: "map", K: 9, V: {
        kind: "scalar",
        T: 9
        /*ScalarType.STRING*/
      }, options: { "google.api.field_behavior": ["OPTIONAL"] } },
      { no: 7, name: "resume_session_id", kind: "scalar", T: 9, options: { "google.api.field_behavior": ["OPTIONAL"] } }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.sandboxId = "";
    message.command = [];
    message.tty = false;
    message.ttyWidth = 0;
    message.ttyHeight = 0;
    message.env = {};
    message.resumeSessionId = "";
    if (value !== void 0)
      reflectionMergePartial4(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* string sandbox_id */
        1:
          message.sandboxId = reader.string();
          break;
        case /* repeated string command */
        2:
          message.command.push(reader.string());
          break;
        case /* bool tty */
        3:
          message.tty = reader.bool();
          break;
        case /* uint32 tty_width */
        4:
          message.ttyWidth = reader.uint32();
          break;
        case /* uint32 tty_height */
        5:
          message.ttyHeight = reader.uint32();
          break;
        case /* map<string, string> env */
        6:
          this.binaryReadMap6(message.env, reader, options);
          break;
        case /* string resume_session_id */
        7:
          message.resumeSessionId = reader.string();
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler4.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  binaryReadMap6(map, reader, options) {
    let len = reader.uint32(), end = reader.pos + len, key, val;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case 1:
          key = reader.string();
          break;
        case 2:
          val = reader.string();
          break;
        default:
          throw new globalThis.Error("unknown map entry field for coreweave.sandbox.v1beta2.ExecStreamInit.env");
      }
    }
    map[key ?? ""] = val ?? "";
  }
  internalBinaryWrite(message, writer, options) {
    if (message.sandboxId !== "")
      writer.tag(1, WireType4.LengthDelimited).string(message.sandboxId);
    for (let i = 0; i < message.command.length; i++)
      writer.tag(2, WireType4.LengthDelimited).string(message.command[i]);
    if (message.tty !== false)
      writer.tag(3, WireType4.Varint).bool(message.tty);
    if (message.ttyWidth !== 0)
      writer.tag(4, WireType4.Varint).uint32(message.ttyWidth);
    if (message.ttyHeight !== 0)
      writer.tag(5, WireType4.Varint).uint32(message.ttyHeight);
    for (let k of globalThis.Object.keys(message.env))
      writer.tag(6, WireType4.LengthDelimited).fork().tag(1, WireType4.LengthDelimited).string(k).tag(2, WireType4.LengthDelimited).string(message.env[k]).join();
    if (message.resumeSessionId !== "")
      writer.tag(7, WireType4.LengthDelimited).string(message.resumeSessionId);
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler4.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var ExecStreamInit = new ExecStreamInit$Type();
var ExecStreamData$Type = class extends MessageType4 {
  constructor() {
    super("coreweave.sandbox.v1beta2.ExecStreamData", [
      { no: 1, name: "data", kind: "scalar", T: 12, options: { "google.api.field_behavior": ["REQUIRED"] } }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.data = new Uint8Array(0);
    if (value !== void 0)
      reflectionMergePartial4(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* bytes data */
        1:
          message.data = reader.bytes();
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler4.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.data.length)
      writer.tag(1, WireType4.LengthDelimited).bytes(message.data);
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler4.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var ExecStreamData = new ExecStreamData$Type();
var ExecStreamResize$Type = class extends MessageType4 {
  constructor() {
    super("coreweave.sandbox.v1beta2.ExecStreamResize", [
      { no: 1, name: "width", kind: "scalar", T: 13, options: { "google.api.field_behavior": ["REQUIRED"] } },
      { no: 2, name: "height", kind: "scalar", T: 13, options: { "google.api.field_behavior": ["REQUIRED"] } }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.width = 0;
    message.height = 0;
    if (value !== void 0)
      reflectionMergePartial4(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* uint32 width */
        1:
          message.width = reader.uint32();
          break;
        case /* uint32 height */
        2:
          message.height = reader.uint32();
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler4.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.width !== 0)
      writer.tag(1, WireType4.Varint).uint32(message.width);
    if (message.height !== 0)
      writer.tag(2, WireType4.Varint).uint32(message.height);
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler4.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var ExecStreamResize = new ExecStreamResize$Type();
var ExecStreamClose$Type = class extends MessageType4 {
  constructor() {
    super("coreweave.sandbox.v1beta2.ExecStreamClose", []);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    if (value !== void 0)
      reflectionMergePartial4(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler4.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler4.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var ExecStreamClose = new ExecStreamClose$Type();
var StreamingExecReady$Type = class extends MessageType4 {
  constructor() {
    super("coreweave.sandbox.v1beta2.StreamingExecReady", [
      { no: 1, name: "ready_at", kind: "message", T: () => Timestamp, options: { "google.api.field_behavior": ["OUTPUT_ONLY"] } },
      { no: 2, name: "session_id", kind: "scalar", T: 9, options: { "google.api.field_behavior": ["OUTPUT_ONLY"] } }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.sessionId = "";
    if (value !== void 0)
      reflectionMergePartial4(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* google.protobuf.Timestamp ready_at */
        1:
          message.readyAt = Timestamp.internalBinaryRead(reader, reader.uint32(), options, message.readyAt);
          break;
        case /* string session_id */
        2:
          message.sessionId = reader.string();
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler4.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.readyAt)
      Timestamp.internalBinaryWrite(message.readyAt, writer.tag(1, WireType4.LengthDelimited).fork(), options).join();
    if (message.sessionId !== "")
      writer.tag(2, WireType4.LengthDelimited).string(message.sessionId);
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler4.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var StreamingExecReady = new StreamingExecReady$Type();
var ExecStreamResponse$Type = class extends MessageType4 {
  constructor() {
    super("coreweave.sandbox.v1beta2.ExecStreamResponse", [
      { no: 1, name: "output", kind: "message", oneof: "response", T: () => ExecStreamOutput },
      { no: 2, name: "exit", kind: "message", oneof: "response", T: () => ExecStreamExit },
      { no: 3, name: "error", kind: "message", oneof: "response", T: () => ExecStreamError },
      { no: 4, name: "ready", kind: "message", oneof: "response", T: () => StreamingExecReady }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.response = { oneofKind: void 0 };
    if (value !== void 0)
      reflectionMergePartial4(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* coreweave.sandbox.v1beta2.ExecStreamOutput output */
        1:
          message.response = {
            oneofKind: "output",
            output: ExecStreamOutput.internalBinaryRead(reader, reader.uint32(), options, message.response.output)
          };
          break;
        case /* coreweave.sandbox.v1beta2.ExecStreamExit exit */
        2:
          message.response = {
            oneofKind: "exit",
            exit: ExecStreamExit.internalBinaryRead(reader, reader.uint32(), options, message.response.exit)
          };
          break;
        case /* coreweave.sandbox.v1beta2.ExecStreamError error */
        3:
          message.response = {
            oneofKind: "error",
            error: ExecStreamError.internalBinaryRead(reader, reader.uint32(), options, message.response.error)
          };
          break;
        case /* coreweave.sandbox.v1beta2.StreamingExecReady ready */
        4:
          message.response = {
            oneofKind: "ready",
            ready: StreamingExecReady.internalBinaryRead(reader, reader.uint32(), options, message.response.ready)
          };
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler4.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.response.oneofKind === "output")
      ExecStreamOutput.internalBinaryWrite(message.response.output, writer.tag(1, WireType4.LengthDelimited).fork(), options).join();
    if (message.response.oneofKind === "exit")
      ExecStreamExit.internalBinaryWrite(message.response.exit, writer.tag(2, WireType4.LengthDelimited).fork(), options).join();
    if (message.response.oneofKind === "error")
      ExecStreamError.internalBinaryWrite(message.response.error, writer.tag(3, WireType4.LengthDelimited).fork(), options).join();
    if (message.response.oneofKind === "ready")
      StreamingExecReady.internalBinaryWrite(message.response.ready, writer.tag(4, WireType4.LengthDelimited).fork(), options).join();
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler4.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var ExecStreamResponse = new ExecStreamResponse$Type();
var ExecStreamOutput$Type = class extends MessageType4 {
  constructor() {
    super("coreweave.sandbox.v1beta2.ExecStreamOutput", [
      { no: 1, name: "stream_type", kind: "enum", T: () => ["coreweave.sandbox.v1beta2.ExecStreamOutput.StreamType", ExecStreamOutput_StreamType, "STREAM_TYPE_"], options: { "google.api.field_behavior": ["REQUIRED"] } },
      { no: 2, name: "data", kind: "scalar", T: 12, options: { "google.api.field_behavior": ["REQUIRED"] } },
      { no: 3, name: "timestamp", kind: "message", T: () => Timestamp, options: { "google.api.field_behavior": ["OUTPUT_ONLY"] } }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.streamType = 0;
    message.data = new Uint8Array(0);
    if (value !== void 0)
      reflectionMergePartial4(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* coreweave.sandbox.v1beta2.ExecStreamOutput.StreamType stream_type */
        1:
          message.streamType = reader.int32();
          break;
        case /* bytes data */
        2:
          message.data = reader.bytes();
          break;
        case /* google.protobuf.Timestamp timestamp */
        3:
          message.timestamp = Timestamp.internalBinaryRead(reader, reader.uint32(), options, message.timestamp);
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler4.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.streamType !== 0)
      writer.tag(1, WireType4.Varint).int32(message.streamType);
    if (message.data.length)
      writer.tag(2, WireType4.LengthDelimited).bytes(message.data);
    if (message.timestamp)
      Timestamp.internalBinaryWrite(message.timestamp, writer.tag(3, WireType4.LengthDelimited).fork(), options).join();
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler4.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var ExecStreamOutput = new ExecStreamOutput$Type();
var ExecStreamExit$Type = class extends MessageType4 {
  constructor() {
    super("coreweave.sandbox.v1beta2.ExecStreamExit", [
      { no: 1, name: "exit_code", kind: "scalar", T: 5, options: { "google.api.field_behavior": ["REQUIRED"] } },
      { no: 2, name: "completed_at", kind: "message", T: () => Timestamp, options: { "google.api.field_behavior": ["OUTPUT_ONLY"] } }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.exitCode = 0;
    if (value !== void 0)
      reflectionMergePartial4(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* int32 exit_code */
        1:
          message.exitCode = reader.int32();
          break;
        case /* google.protobuf.Timestamp completed_at */
        2:
          message.completedAt = Timestamp.internalBinaryRead(reader, reader.uint32(), options, message.completedAt);
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler4.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.exitCode !== 0)
      writer.tag(1, WireType4.Varint).int32(message.exitCode);
    if (message.completedAt)
      Timestamp.internalBinaryWrite(message.completedAt, writer.tag(2, WireType4.LengthDelimited).fork(), options).join();
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler4.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var ExecStreamExit = new ExecStreamExit$Type();
var ExecStreamError$Type = class extends MessageType4 {
  constructor() {
    super("coreweave.sandbox.v1beta2.ExecStreamError", [
      { no: 1, name: "message", kind: "scalar", T: 9, options: { "google.api.field_behavior": ["REQUIRED"] } },
      { no: 2, name: "code", kind: "scalar", T: 9, options: { "google.api.field_behavior": ["REQUIRED"] } }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.message = "";
    message.code = "";
    if (value !== void 0)
      reflectionMergePartial4(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* string message */
        1:
          message.message = reader.string();
          break;
        case /* string code */
        2:
          message.code = reader.string();
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler4.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.message !== "")
      writer.tag(1, WireType4.LengthDelimited).string(message.message);
    if (message.code !== "")
      writer.tag(2, WireType4.LengthDelimited).string(message.code);
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler4.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var ExecStreamError = new ExecStreamError$Type();
var LogStreamRequest$Type = class extends MessageType4 {
  constructor() {
    super("coreweave.sandbox.v1beta2.LogStreamRequest", [
      { no: 1, name: "init", kind: "message", oneof: "request", T: () => LogStreamInit },
      { no: 2, name: "close", kind: "message", oneof: "request", T: () => LogStreamClose }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.request = { oneofKind: void 0 };
    if (value !== void 0)
      reflectionMergePartial4(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* coreweave.sandbox.v1beta2.LogStreamInit init */
        1:
          message.request = {
            oneofKind: "init",
            init: LogStreamInit.internalBinaryRead(reader, reader.uint32(), options, message.request.init)
          };
          break;
        case /* coreweave.sandbox.v1beta2.LogStreamClose close */
        2:
          message.request = {
            oneofKind: "close",
            close: LogStreamClose.internalBinaryRead(reader, reader.uint32(), options, message.request.close)
          };
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler4.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.request.oneofKind === "init")
      LogStreamInit.internalBinaryWrite(message.request.init, writer.tag(1, WireType4.LengthDelimited).fork(), options).join();
    if (message.request.oneofKind === "close")
      LogStreamClose.internalBinaryWrite(message.request.close, writer.tag(2, WireType4.LengthDelimited).fork(), options).join();
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler4.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var LogStreamRequest = new LogStreamRequest$Type();
var LogStreamInit$Type = class extends MessageType4 {
  constructor() {
    super("coreweave.sandbox.v1beta2.LogStreamInit", [
      { no: 1, name: "sandbox_id", kind: "scalar", T: 9, options: { "google.api.field_behavior": ["REQUIRED"] } },
      { no: 2, name: "follow", kind: "scalar", T: 8, options: { "google.api.field_behavior": ["OPTIONAL"] } },
      { no: 3, name: "tail_lines", kind: "scalar", T: 5, options: { "google.api.field_behavior": ["OPTIONAL"] } },
      { no: 4, name: "since_time", kind: "message", T: () => Timestamp, options: { "google.api.field_behavior": ["OPTIONAL"] } },
      { no: 5, name: "timestamps", kind: "scalar", T: 8, options: { "google.api.field_behavior": ["OPTIONAL"] } },
      { no: 6, name: "resume_session_id", kind: "scalar", T: 9, options: { "google.api.field_behavior": ["OPTIONAL"] } },
      { no: 7, name: "resume_offset", kind: "scalar", T: 4, options: { "google.api.field_behavior": ["OPTIONAL"] } }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.sandboxId = "";
    message.follow = false;
    message.tailLines = 0;
    message.timestamps = false;
    message.resumeSessionId = "";
    message.resumeOffset = "0";
    if (value !== void 0)
      reflectionMergePartial4(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* string sandbox_id */
        1:
          message.sandboxId = reader.string();
          break;
        case /* bool follow */
        2:
          message.follow = reader.bool();
          break;
        case /* int32 tail_lines */
        3:
          message.tailLines = reader.int32();
          break;
        case /* google.protobuf.Timestamp since_time */
        4:
          message.sinceTime = Timestamp.internalBinaryRead(reader, reader.uint32(), options, message.sinceTime);
          break;
        case /* bool timestamps */
        5:
          message.timestamps = reader.bool();
          break;
        case /* string resume_session_id */
        6:
          message.resumeSessionId = reader.string();
          break;
        case /* uint64 resume_offset */
        7:
          message.resumeOffset = reader.uint64().toString();
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler4.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.sandboxId !== "")
      writer.tag(1, WireType4.LengthDelimited).string(message.sandboxId);
    if (message.follow !== false)
      writer.tag(2, WireType4.Varint).bool(message.follow);
    if (message.tailLines !== 0)
      writer.tag(3, WireType4.Varint).int32(message.tailLines);
    if (message.sinceTime)
      Timestamp.internalBinaryWrite(message.sinceTime, writer.tag(4, WireType4.LengthDelimited).fork(), options).join();
    if (message.timestamps !== false)
      writer.tag(5, WireType4.Varint).bool(message.timestamps);
    if (message.resumeSessionId !== "")
      writer.tag(6, WireType4.LengthDelimited).string(message.resumeSessionId);
    if (message.resumeOffset !== "0")
      writer.tag(7, WireType4.Varint).uint64(message.resumeOffset);
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler4.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var LogStreamInit = new LogStreamInit$Type();
var LogStreamClose$Type = class extends MessageType4 {
  constructor() {
    super("coreweave.sandbox.v1beta2.LogStreamClose", []);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    if (value !== void 0)
      reflectionMergePartial4(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler4.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler4.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var LogStreamClose = new LogStreamClose$Type();
var LogStreamResponse$Type = class extends MessageType4 {
  constructor() {
    super("coreweave.sandbox.v1beta2.LogStreamResponse", [
      { no: 1, name: "data", kind: "message", oneof: "response", T: () => LogStreamData },
      { no: 2, name: "error", kind: "message", oneof: "response", T: () => LogStreamError },
      { no: 3, name: "complete", kind: "message", oneof: "response", T: () => LogStreamComplete }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.response = { oneofKind: void 0 };
    if (value !== void 0)
      reflectionMergePartial4(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* coreweave.sandbox.v1beta2.LogStreamData data */
        1:
          message.response = {
            oneofKind: "data",
            data: LogStreamData.internalBinaryRead(reader, reader.uint32(), options, message.response.data)
          };
          break;
        case /* coreweave.sandbox.v1beta2.LogStreamError error */
        2:
          message.response = {
            oneofKind: "error",
            error: LogStreamError.internalBinaryRead(reader, reader.uint32(), options, message.response.error)
          };
          break;
        case /* coreweave.sandbox.v1beta2.LogStreamComplete complete */
        3:
          message.response = {
            oneofKind: "complete",
            complete: LogStreamComplete.internalBinaryRead(reader, reader.uint32(), options, message.response.complete)
          };
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler4.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.response.oneofKind === "data")
      LogStreamData.internalBinaryWrite(message.response.data, writer.tag(1, WireType4.LengthDelimited).fork(), options).join();
    if (message.response.oneofKind === "error")
      LogStreamError.internalBinaryWrite(message.response.error, writer.tag(2, WireType4.LengthDelimited).fork(), options).join();
    if (message.response.oneofKind === "complete")
      LogStreamComplete.internalBinaryWrite(message.response.complete, writer.tag(3, WireType4.LengthDelimited).fork(), options).join();
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler4.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var LogStreamResponse = new LogStreamResponse$Type();
var LogStreamData$Type = class extends MessageType4 {
  constructor() {
    super("coreweave.sandbox.v1beta2.LogStreamData", [
      { no: 1, name: "data", kind: "scalar", T: 12, options: { "google.api.field_behavior": ["REQUIRED"] } },
      { no: 2, name: "timestamp", kind: "message", T: () => Timestamp, options: { "google.api.field_behavior": ["OPTIONAL"] } },
      { no: 3, name: "session_id", kind: "scalar", T: 9, options: { "google.api.field_behavior": ["OUTPUT_ONLY"] } },
      { no: 4, name: "offset", kind: "scalar", T: 4, options: { "google.api.field_behavior": ["OUTPUT_ONLY"] } }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.data = new Uint8Array(0);
    message.sessionId = "";
    message.offset = "0";
    if (value !== void 0)
      reflectionMergePartial4(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* bytes data */
        1:
          message.data = reader.bytes();
          break;
        case /* google.protobuf.Timestamp timestamp */
        2:
          message.timestamp = Timestamp.internalBinaryRead(reader, reader.uint32(), options, message.timestamp);
          break;
        case /* string session_id */
        3:
          message.sessionId = reader.string();
          break;
        case /* uint64 offset */
        4:
          message.offset = reader.uint64().toString();
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler4.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.data.length)
      writer.tag(1, WireType4.LengthDelimited).bytes(message.data);
    if (message.timestamp)
      Timestamp.internalBinaryWrite(message.timestamp, writer.tag(2, WireType4.LengthDelimited).fork(), options).join();
    if (message.sessionId !== "")
      writer.tag(3, WireType4.LengthDelimited).string(message.sessionId);
    if (message.offset !== "0")
      writer.tag(4, WireType4.Varint).uint64(message.offset);
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler4.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var LogStreamData = new LogStreamData$Type();
var LogStreamComplete$Type = class extends MessageType4 {
  constructor() {
    super("coreweave.sandbox.v1beta2.LogStreamComplete", []);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    if (value !== void 0)
      reflectionMergePartial4(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler4.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler4.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var LogStreamComplete = new LogStreamComplete$Type();
var LogStreamError$Type = class extends MessageType4 {
  constructor() {
    super("coreweave.sandbox.v1beta2.LogStreamError", [
      { no: 1, name: "message", kind: "scalar", T: 9, options: { "google.api.field_behavior": ["REQUIRED"] } },
      { no: 2, name: "code", kind: "scalar", T: 9, options: { "google.api.field_behavior": ["REQUIRED"] } }
    ]);
  }
  create(value) {
    const message = globalThis.Object.create(this.messagePrototype);
    message.message = "";
    message.code = "";
    if (value !== void 0)
      reflectionMergePartial4(this, message, value);
    return message;
  }
  internalBinaryRead(reader, length, options, target) {
    let message = target ?? this.create(), end = reader.pos + length;
    while (reader.pos < end) {
      let [fieldNo, wireType] = reader.tag();
      switch (fieldNo) {
        case /* string message */
        1:
          message.message = reader.string();
          break;
        case /* string code */
        2:
          message.code = reader.string();
          break;
        default:
          let u = options.readUnknownField;
          if (u === "throw")
            throw new globalThis.Error(`Unknown field ${fieldNo} (wire type ${wireType}) for ${this.typeName}`);
          let d = reader.skip(wireType);
          if (u !== false)
            (u === true ? UnknownFieldHandler4.onRead : u)(this.typeName, message, fieldNo, wireType, d);
      }
    }
    return message;
  }
  internalBinaryWrite(message, writer, options) {
    if (message.message !== "")
      writer.tag(1, WireType4.LengthDelimited).string(message.message);
    if (message.code !== "")
      writer.tag(2, WireType4.LengthDelimited).string(message.code);
    let u = options.writeUnknownFields;
    if (u !== false)
      (u == true ? UnknownFieldHandler4.onWrite : u)(this.typeName, message, writer);
    return writer;
  }
};
var LogStreamError = new LogStreamError$Type();
var GatewayStreamingService = new ServiceType3("coreweave.sandbox.v1beta2.GatewayStreamingService", [
  { name: "StreamExec", serverStreaming: true, clientStreaming: true, options: {}, I: ExecStreamRequest, O: ExecStreamResponse },
  { name: "StreamLogs", serverStreaming: true, clientStreaming: true, options: {}, I: LogStreamRequest, O: LogStreamResponse }
]);

// src/node/generated/coreweave/sandbox/v1beta2/streaming.client.ts
import { stackIntercept as stackIntercept2 } from "@protobuf-ts/runtime-rpc";
var GatewayStreamingServiceClient = class {
  constructor(_transport) {
    this._transport = _transport;
  }
  _transport;
  typeName = GatewayStreamingService.typeName;
  methods = GatewayStreamingService.methods;
  options = GatewayStreamingService.options;
  /**
   * StreamExec executes a command with real-time stdin/stdout/stderr streaming.
   * The client sends ExecStreamRequest messages (init, stdin, resize, close).
   * The server sends ExecStreamResponse messages (output, exit, error).
   *
   * @generated from protobuf rpc: StreamExec
   */
  streamExec(options) {
    const method = this.methods[0], opt = this._transport.mergeOptions(options);
    return stackIntercept2("duplex", this._transport, method, opt);
  }
  /**
   * StreamLogs tails logs from a sandbox in real-time.
   * The client sends LogStreamRequest messages (init, close).
   * The server sends LogStreamResponse messages (data, error, complete).
   *
   * @generated from protobuf rpc: StreamLogs
   */
  streamLogs(options) {
    const method = this.methods[1], opt = this._transport.mergeOptions(options);
    return stackIntercept2("duplex", this._transport, method, opt);
  }
};

// src/node/grpc-channel.ts
function createGrpcClients(options) {
  const target = parseGrpcTarget(options.baseUrl);
  const transport = new GrpcTransport({
    channelCredentials: target.secure ? ChannelCredentials.createSsl() : ChannelCredentials.createInsecure(),
    host: target.host,
    meta: toGrpcMetadata(options)
  });
  return {
    client: new GatewayServiceClient(transport),
    streamingClient: new GatewayStreamingServiceClient(transport)
  };
}
function toGrpcMetadata(options) {
  if (options.metadata !== void 0) {
    return { ...options.metadata };
  }
  if (options.apiKey !== void 0) {
    return {
      authorization: `Bearer ${options.apiKey}`
    };
  }
  throw new CWSandboxConfigurationError("CWSandbox gRPC metadata or API key is required.");
}
function parseGrpcTarget(baseUrl) {
  const url = parseBaseUrl(baseUrl);
  if (url.protocol === "https:") {
    return { host: url.host, secure: true };
  }
  if (url.protocol === "http:") {
    return { host: url.host, secure: false };
  }
  throw new CWSandboxConfigurationError(`Unsupported CWSandbox base URL protocol: ${url.protocol}`);
}
function parseBaseUrl(baseUrl) {
  try {
    return new URL(baseUrl);
  } catch (error) {
    throw new CWSandboxConfigurationError(`Invalid CWSandbox base URL: ${baseUrl}`, {
      cause: error
    });
  }
}

// src/streaming/async-queue.ts
var AsyncQueue = class {
  constructor(capacity = 64) {
    this.capacity = capacity;
  }
  capacity;
  items = [];
  waitingConsumers = [];
  waitingProducers = [];
  closed = false;
  consumed = false;
  error;
  [Symbol.asyncIterator]() {
    if (this.consumed) {
      throw new Error("Stream already has a consumer.");
    }
    this.consumed = true;
    return {
      next: () => this.next()
    };
  }
  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.drainConsumers();
    this.releaseProducers();
  }
  fail(error) {
    if (this.closed) {
      return;
    }
    this.error = error;
    this.closed = true;
    this.drainConsumers();
    this.releaseProducers();
  }
  async push(item) {
    if (this.closed) {
      return;
    }
    while (this.items.length >= this.capacity && !this.closed) {
      await new Promise((resolve) => {
        this.waitingProducers.push(resolve);
      });
    }
    if (this.closed) {
      return;
    }
    const consumer = this.waitingConsumers.shift();
    if (consumer !== void 0) {
      consumer.resolve({ done: false, value: item });
      return;
    }
    this.items.push(item);
  }
  tryPush(item) {
    if (this.closed) {
      return false;
    }
    const consumer = this.waitingConsumers.shift();
    if (consumer !== void 0) {
      consumer.resolve({ done: false, value: item });
      return true;
    }
    if (this.items.length >= this.capacity) {
      return false;
    }
    this.items.push(item);
    return true;
  }
  drainConsumers() {
    while (this.waitingConsumers.length > 0) {
      const consumer = this.waitingConsumers.shift();
      if (consumer === void 0) {
        return;
      }
      if (this.error === void 0) {
        consumer.resolve({ done: true, value: void 0 });
      } else {
        consumer.reject(this.error);
      }
    }
  }
  next() {
    if (this.items.length > 0) {
      const value = this.items.shift();
      this.releaseProducer();
      if (value !== void 0) {
        return Promise.resolve({ done: false, value });
      }
    }
    if (this.error !== void 0) {
      return Promise.reject(this.error);
    }
    if (this.closed) {
      return Promise.resolve({ done: true, value: void 0 });
    }
    return new Promise((resolve, reject) => {
      this.waitingConsumers.push({ reject, resolve });
    });
  }
  releaseProducer() {
    this.waitingProducers.shift()?.();
  }
  releaseProducers() {
    while (this.waitingProducers.length > 0) {
      this.releaseProducer();
    }
  }
};

// src/streaming/command-process.ts
var textDecoder2 = new TextDecoder();
var textEncoder = new TextEncoder();
var OUTPUT_ACCUMULATION_LIMIT_BYTES = 1024 * 1024;
function createCommandProcess(command, options = {}) {
  const process = new StreamingCommandProcess(command, options);
  return {
    process,
    dispatch: (event) => process.dispatch(event)
  };
}
var OutputAccumulator = class {
  constructor(limitBytes = OUTPUT_ACCUMULATION_LIMIT_BYTES) {
    this.limitBytes = limitBytes;
  }
  limitBytes;
  chunks = [];
  bytes = 0;
  bytesProduced = 0;
  truncated = false;
  append(data) {
    this.bytesProduced += data.byteLength;
    if (this.bytes >= this.limitBytes) {
      this.truncated = true;
      return;
    }
    const remaining = this.limitBytes - this.bytes;
    const chunk = data.byteLength > remaining ? data.slice(0, remaining) : data;
    this.chunks.push(chunk);
    this.bytes += chunk.byteLength;
    this.truncated ||= chunk.byteLength < data.byteLength;
  }
  text() {
    return textDecoder2.decode(this.bytesValue());
  }
  bytesValue() {
    const output = new Uint8Array(this.bytes);
    let offset = 0;
    for (const chunk of this.chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output;
  }
  produced() {
    return this.bytesProduced;
  }
  isTruncated() {
    return this.truncated;
  }
};
var StreamingCommandProcess = class {
  constructor(command, options) {
    this.command = command;
    const limitBytes = options.bufferedMaxKiB === void 0 ? OUTPUT_ACCUMULATION_LIMIT_BYTES : options.bufferedMaxKiB * 1024;
    this.input = options.input;
    this.stdoutAccumulator = new OutputAccumulator(limitBytes);
    this.stderrAccumulator = new OutputAccumulator(limitBytes);
    this.stdout = this.stdoutQueue;
    this.stderr = this.stderrQueue;
    this.stdin = options.stdin === true && options.input !== void 0 ? new StreamingCommandInputWriter(options.input, () => this.currentStatus) : void 0;
    this.waitPromise = new Promise((resolve, reject) => {
      this.resolveWait = resolve;
      this.rejectWait = reject;
    });
  }
  command;
  stderr;
  stdin;
  stdout;
  stderrQueue = new AsyncQueue();
  stdoutQueue = new AsyncQueue();
  stderrAccumulator;
  stdoutAccumulator;
  result;
  sessionId;
  currentExitCode;
  currentStatus = "starting";
  input;
  waitPromise;
  rejectWait;
  resolveWait;
  settled = false;
  async dispatch(event) {
    switch (event.type) {
      case "ready":
        this.sessionId = event.sessionId;
        this.currentStatus = "running";
        return;
      case "stdout":
        this.stdoutAccumulator.append(event.data);
        this.stdoutQueue.tryPush(textDecoder2.decode(event.data));
        return;
      case "stderr":
        this.stderrAccumulator.append(event.data);
        this.stderrQueue.tryPush(textDecoder2.decode(event.data));
        return;
      case "exit":
        if (this.settled) {
          return;
        }
        this.currentStatus = "exited";
        this.currentExitCode = event.exitCode;
        this.result = {
          command: this.command,
          exitCode: event.exitCode,
          failed: event.exitCode !== 0,
          ok: event.exitCode === 0,
          stderr: this.stderrAccumulator.text(),
          stderrBytes: this.stderrAccumulator.bytesValue(),
          stderrBytesProduced: this.stderrAccumulator.produced(),
          stderrTruncated: this.stderrAccumulator.isTruncated(),
          stdout: this.stdoutAccumulator.text(),
          stdoutBytes: this.stdoutAccumulator.bytesValue(),
          stdoutBytesProduced: this.stdoutAccumulator.produced(),
          stdoutTruncated: this.stdoutAccumulator.isTruncated()
        };
        this.stdoutQueue.close();
        this.stderrQueue.close();
        this.resolve(this.result);
        return;
      case "error":
        if (this.settled) {
          return;
        }
        this.currentStatus = "failed";
        this.stdoutQueue.fail(event.error);
        this.stderrQueue.fail(event.error);
        this.reject(event.error);
        return;
    }
  }
  async cancel(options = {}) {
    try {
      validateRequestOptions(options);
      options.signal?.throwIfAborted();
    } catch (error2) {
      return Promise.reject(error2);
    }
    if (this.settled) {
      return;
    }
    const error = new CWSandboxTransportError("Streaming command cancelled.", {
      operation: "Cancel streaming command"
    });
    this.currentStatus = "cancelled";
    this.stdoutQueue.fail(error);
    this.stderrQueue.fail(error);
    this.reject(error);
    await this.cancelInput(error);
  }
  wait(options = {}) {
    try {
      validateRequestOptions(options);
      options.signal?.throwIfAborted();
    } catch (error) {
      return Promise.reject(error);
    }
    return waitWithRequestOptions(this.waitPromise, options);
  }
  get exitCode() {
    return this.currentExitCode;
  }
  poll() {
    return this.currentExitCode;
  }
  get status() {
    return this.currentStatus;
  }
  async cancelInput(reason) {
    if (this.stdin instanceof StreamingCommandInputWriter) {
      await this.stdin.cancel(reason);
      return;
    }
    await this.input?.cancel(reason);
  }
  reject(error) {
    this.settled = true;
    this.rejectWait(error);
  }
  resolve(result) {
    this.settled = true;
    this.resolveWait(result);
  }
};
var StreamingCommandInputWriter = class {
  constructor(input, status) {
    this.input = input;
    this.status = status;
  }
  input;
  status;
  writeQueue = Promise.resolve();
  isClosed = false;
  get closed() {
    return this.isClosed;
  }
  close(options = {}) {
    try {
      validateRequestOptions(options);
      options.signal?.throwIfAborted();
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.isClosed) {
      return Promise.resolve();
    }
    this.isClosed = true;
    this.writeQueue = this.writeQueue.then(() => this.input.close());
    return this.writeQueue;
  }
  async cancel(reason) {
    this.isClosed = true;
    await this.input.cancel(reason);
  }
  write(data, options = {}) {
    let bytes;
    try {
      validateRequestOptions(options);
      options.signal?.throwIfAborted();
      this.validateCanWrite();
      bytes = normalizeInputData(data);
    } catch (error) {
      return Promise.reject(error);
    }
    this.writeQueue = this.writeQueue.then(() => this.input.write(bytes));
    return this.writeQueue;
  }
  writeln(text, options = {}) {
    if (typeof text !== "string") {
      return Promise.reject(new CWSandboxValidationError("stdin.writeln text must be a string."));
    }
    return this.write(`${text}
`, options);
  }
  validateCanWrite() {
    if (this.isClosed) {
      throw new CWSandboxValidationError("stdin is closed.");
    }
    const status = this.status();
    if (status === "cancelled" || status === "exited" || status === "failed") {
      throw new CWSandboxValidationError(`Cannot write stdin after process status '${status}'.`);
    }
  }
};
function normalizeInputData(data) {
  if (typeof data === "string") {
    return textEncoder.encode(data);
  }
  if (data instanceof Uint8Array) {
    return data;
  }
  throw new CWSandboxValidationError("stdin.write data must be a string or Uint8Array.");
}
function waitWithRequestOptions(promise, options) {
  if (options.timeoutMs === void 0 && options.signal === void 0) {
    return promise;
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout;
    const cleanup = () => {
      if (timeout !== void 0) {
        clearTimeout(timeout);
      }
      options.signal?.removeEventListener("abort", onAbort);
    };
    const settle = (callback) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback();
    };
    const onAbort = () => {
      try {
        options.signal?.throwIfAborted();
      } catch (error) {
        settle(() => reject(error));
      }
    };
    if (options.timeoutMs !== void 0) {
      timeout = setTimeout(() => {
        settle(
          () => reject(
            new CWSandboxTimeoutError("Timed out waiting for streaming command to complete.", {
              operation: "Wait for streaming command"
            })
          )
        );
      }, options.timeoutMs);
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        settle(() => resolve(value));
      },
      (error) => {
        settle(() => reject(error));
      }
    );
  });
}

// src/node/errors.ts
import { RpcError } from "@protobuf-ts/runtime-rpc";
function mapGrpcError(error, context) {
  if (error instanceof RpcError) {
    const details = grpcErrorOptions(error, context);
    const message = `${context.operation} failed: ${error.message}`;
    switch (error.code) {
      case "UNAUTHENTICATED":
      case "PERMISSION_DENIED":
        return new CWSandboxAuthenticationError(message, details);
      case "NOT_FOUND":
        return new CWSandboxNotFoundError(message, details);
      case "DEADLINE_EXCEEDED":
        return new CWSandboxTimeoutError(message, details);
      case "UNAVAILABLE":
        return new CWSandboxUnavailableError(message, details);
      case "RESOURCE_EXHAUSTED":
        return new CWSandboxResourceExhaustedError(message, details);
      default:
        return new CWSandboxTransportError(message, details);
    }
  }
  return new CWSandboxTransportError(`${context.operation} failed.`, {
    ...context,
    cause: error,
    transport: "grpc"
  });
}
function grpcErrorOptions(error, context) {
  return {
    ...context,
    cause: grpcErrorCause(error),
    metadata: error.meta,
    transport: "grpc",
    transportCode: error.code
  };
}
function grpcErrorCause(error) {
  const cause = new Error(error.message);
  cause.name = "RpcError";
  return cause;
}

// src/node/grpc-rpc.ts
async function withGrpcErrorMapping(operation, run, sandboxId) {
  try {
    return await run();
  } catch (error) {
    throw mapGrpcError(error, sandboxId === void 0 ? { operation } : { operation, sandboxId });
  }
}
function toRpcOptions(request) {
  return {
    ...request.signal ? { abort: request.signal } : {},
    ...request.timeoutMs === void 0 ? {} : { timeout: request.timeoutMs }
  };
}
function linkedAbortController(signal) {
  const controller = new AbortController();
  if (signal === void 0) {
    return controller;
  }
  if (signal.aborted) {
    controller.abort(signal.reason);
    return controller;
  }
  signal.addEventListener(
    "abort",
    () => {
      controller.abort(signal.reason);
    },
    { once: true }
  );
  return controller;
}

// src/node/streaming-requests.ts
function toStreamingInitRequest(request) {
  return {
    request: {
      init: {
        command: commandForWorkingDirectory(request.command, request.cwd),
        env: {},
        resumeSessionId: "",
        sandboxId: request.sandboxId,
        tty: false,
        ttyHeight: 0,
        ttyWidth: 0
      },
      oneofKind: "init"
    }
  };
}
function toStreamingStdinRequest(data) {
  return {
    request: {
      oneofKind: "stdin",
      stdin: {
        data
      }
    }
  };
}
function toStreamingCloseRequest() {
  return {
    request: {
      close: {},
      oneofKind: "close"
    }
  };
}
async function sendStreamingInit(writer, request) {
  await writer.send(toStreamingInitRequest(request));
}
async function sendStreamingStdin(writer, data) {
  await writer.send(toStreamingStdinRequest(data));
}
async function sendStreamingClose(writer) {
  await writer.send(toStreamingCloseRequest());
}

// src/node/grpc-command-stream.ts
async function startGrpcCommand(streamingClient, request) {
  const abortController = linkedAbortController(request.signal);
  const call = streamingClient.streamExec(
    toRpcOptions({
      ...request,
      signal: abortController.signal
    })
  );
  let requestsCompleted = false;
  const completeRequests = async () => {
    if (requestsCompleted) {
      return;
    }
    requestsCompleted = true;
    await call.requests.complete();
  };
  const input = createGrpcCommandInputController(call, completeRequests, abortController, request);
  const commandProcessOptions = request.stdin === true ? {
    ...request.bufferedMaxKiB === void 0 ? {} : { bufferedMaxKiB: request.bufferedMaxKiB },
    input,
    stdin: true
  } : {
    ...request.bufferedMaxKiB === void 0 ? {} : { bufferedMaxKiB: request.bufferedMaxKiB },
    input
  };
  const controller = createCommandProcess(request.command, commandProcessOptions);
  await withGrpcErrorMapping(
    "Start streaming command",
    async () => {
      await sendStreamingInit(call.requests, request);
      if (request.stdin !== true) {
        await completeRequests();
      }
    },
    request.sandboxId
  );
  void collectStreamingCommand(call, controller, request, completeRequests);
  return controller.process;
}
async function collectStreamingCommand(call, controller, request, onTerminal = async () => void 0) {
  let terminal = false;
  try {
    for await (const response of call.responses) {
      switch (response.response.oneofKind) {
        case "ready":
          await controller.dispatch({
            sessionId: response.response.ready.sessionId,
            type: "ready"
          });
          break;
        case "output":
          await controller.dispatch({
            data: response.response.output.data,
            type: response.response.output.streamType === 2 /* STDERR */ ? "stderr" : "stdout"
          });
          break;
        case "exit":
          terminal = true;
          await controller.dispatch({
            exitCode: response.response.exit.exitCode,
            type: "exit"
          });
          await onTerminal().catch(() => void 0);
          break;
        case "error":
          terminal = true;
          await controller.dispatch({
            error: new CWSandboxTransportError(
              response.response.error.message || "Streaming command failed.",
              {
                operation: "Streaming command",
                sandboxId: request.sandboxId,
                transport: "grpc",
                transportCode: response.response.error.code
              }
            ),
            type: "error"
          });
          await onTerminal().catch(() => void 0);
          break;
        case void 0:
          break;
      }
    }
    await call.status;
    if (!terminal) {
      await controller.dispatch({
        error: new CWSandboxTransportError("Streaming command ended without an exit status.", {
          operation: "Streaming command",
          sandboxId: request.sandboxId,
          transport: "grpc"
        }),
        type: "error"
      });
    }
  } catch (error) {
    await controller.dispatch({
      error: mapGrpcError(error, {
        operation: "Streaming command",
        sandboxId: request.sandboxId
      }),
      type: "error"
    });
  } finally {
    await onTerminal().catch(() => void 0);
  }
}
function createGrpcCommandInputController(call, completeRequests, abortController, request) {
  return {
    async cancel(reason) {
      abortController.abort(reason);
    },
    async close() {
      await withGrpcErrorMapping(
        "Close streaming stdin",
        async () => {
          await sendStreamingClose(call.requests);
          await completeRequests();
        },
        request.sandboxId
      );
    },
    async write(data) {
      await withGrpcErrorMapping(
        "Write streaming stdin",
        () => sendStreamingStdin(call.requests, data),
        request.sandboxId
      );
    }
  };
}

// src/streaming/log-stream.ts
var MAX_LINE_BUFFER_BYTES = 64 * 1024;
var textDecoder3 = new TextDecoder();
var textEncoder2 = new TextEncoder();
function createLogStream(mode, controls) {
  const stream = new StreamingLogStream(mode, controls);
  return {
    stream,
    dispatch: (event) => stream.dispatch(event)
  };
}
var StreamingLogStream = class {
  constructor(mode, controls) {
    this.mode = mode;
    this.controls = controls;
  }
  mode;
  controls;
  queue = new AsyncQueue();
  buffer = "";
  bufferBytes = 0;
  bufferMetadata = {};
  currentOffset;
  currentSessionId;
  isClosed = false;
  [Symbol.asyncIterator]() {
    return this.queue[Symbol.asyncIterator]();
  }
  async cancel(options = {}) {
    try {
      validateRequestOptions(options);
      options.signal?.throwIfAborted();
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.isClosed) {
      return;
    }
    this.isClosed = true;
    await this.controls.cancel(
      new CWSandboxTransportError("Log stream cancelled.", {
        operation: "Cancel log stream"
      })
    );
    this.queue.close();
  }
  async close(options = {}) {
    try {
      validateRequestOptions(options);
      options.signal?.throwIfAborted();
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.isClosed) {
      return;
    }
    this.isClosed = true;
    await this.controls.close();
    await this.flushRemainder();
    this.queue.close();
  }
  get closed() {
    return this.isClosed;
  }
  get offset() {
    return this.currentOffset;
  }
  get sessionId() {
    return this.currentSessionId;
  }
  async dispatch(event) {
    if (this.isClosed && event.type !== "error") {
      return;
    }
    switch (event.type) {
      case "complete":
        this.isClosed = true;
        await this.flushRemainder();
        this.queue.close();
        return;
      case "data":
        await this.handleData(event);
        return;
      case "error":
        this.isClosed = true;
        this.queue.fail(event.error);
        return;
    }
  }
  async handleData(event) {
    this.currentOffset = event.offset;
    this.currentSessionId = event.sessionId;
    if (this.mode === "raw") {
      await this.queue.push({
        data: event.data,
        ...event.offset === void 0 ? {} : { offset: event.offset },
        ...event.sessionId === void 0 ? {} : { sessionId: event.sessionId },
        text: textDecoder3.decode(event.data),
        ...event.timestamp === void 0 ? {} : { timestamp: timestampToDate(event.timestamp) }
      });
      return;
    }
    await this.handleLineData(event);
  }
  async handleLineData(event) {
    const text = textDecoder3.decode(event.data);
    this.buffer += text;
    this.bufferBytes += event.data.byteLength;
    this.bufferMetadata = metadataFromEvent(event);
    if (!this.buffer.includes("\n") && this.bufferBytes < MAX_LINE_BUFFER_BYTES) {
      return;
    }
    const parts = this.buffer.split("\n");
    const completeParts = parts.slice(0, -1);
    for (const part of completeParts) {
      await this.pushLine(`${part}
`, this.bufferMetadata);
    }
    const remainder = parts.at(-1) ?? "";
    this.buffer = remainder;
    this.bufferBytes = textEncoder2.encode(remainder).byteLength;
    if (this.bufferBytes >= MAX_LINE_BUFFER_BYTES) {
      await this.pushLine(this.buffer, this.bufferMetadata);
      this.buffer = "";
      this.bufferBytes = 0;
    }
  }
  async flushRemainder() {
    if (this.buffer === "") {
      return;
    }
    await this.pushLine(this.buffer, this.bufferMetadata);
    this.buffer = "";
    this.bufferBytes = 0;
  }
  async pushLine(line, metadata) {
    if (this.mode === "entries") {
      await this.queue.push({
        line,
        ...metadata
      });
      return;
    }
    await this.queue.push(line);
  }
};
function metadataFromEvent(event) {
  return {
    ...event.offset === void 0 ? {} : { offset: event.offset },
    ...event.sessionId === void 0 ? {} : { sessionId: event.sessionId },
    ...event.timestamp === void 0 ? {} : { timestamp: timestampToDate(event.timestamp) }
  };
}
function timestampToDate(timestamp) {
  return new Date(Number(timestamp.seconds) * 1e3 + Math.floor(timestamp.nanos / 1e6));
}

// src/node/log-streaming-requests.ts
function toLogStreamInitRequest(request) {
  return {
    request: {
      init: {
        follow: request.follow ?? false,
        resumeOffset: request.resume === void 0 ? "0" : String(request.resume.offset),
        resumeSessionId: request.resume?.sessionId ?? "",
        sandboxId: request.sandboxId,
        ...request.sinceTime === void 0 ? {} : { sinceTime: toProtoTimestamp(request.sinceTime) },
        tailLines: request.tailLines ?? 0,
        timestamps: request.timestamps ?? false
      },
      oneofKind: "init"
    }
  };
}
function toLogStreamCloseRequest() {
  return {
    request: {
      close: {},
      oneofKind: "close"
    }
  };
}
async function sendLogStreamInit(writer, request) {
  await writer.send(toLogStreamInitRequest(request));
}
async function sendLogStreamClose(writer) {
  await writer.send(toLogStreamCloseRequest());
}
function toProtoTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  const millis = date.getTime();
  const seconds = Math.floor(millis / 1e3);
  return {
    nanos: (millis - seconds * 1e3) * 1e6,
    seconds: String(seconds)
  };
}

// src/node/grpc-log-stream.ts
async function startGrpcLogStream(streamingClient, request) {
  const abortController = linkedAbortController(request.signal);
  const call = streamingClient.streamLogs(
    toRpcOptions({
      ...request,
      signal: abortController.signal
    })
  );
  let requestsCompleted = false;
  const completeRequests = async () => {
    if (requestsCompleted) {
      return;
    }
    requestsCompleted = true;
    await call.requests.complete();
  };
  const controls = {
    async cancel(reason) {
      abortController.abort(reason);
    },
    async close() {
      await withGrpcErrorMapping(
        "Close log stream",
        async () => {
          await sendLogStreamClose(call.requests);
          await completeRequests();
        },
        request.sandboxId
      );
    }
  };
  const controller = createLogStream(request.mode, controls);
  await withGrpcErrorMapping(
    "Stream logs",
    async () => {
      await sendLogStreamInit(call.requests, request);
      if (request.follow !== true) {
        await completeRequests();
      }
    },
    request.sandboxId
  );
  void collectLogStream(call, controller, request, completeRequests);
  return controller.stream;
}
async function collectLogStream(call, controller, request, onTerminal) {
  let terminal = false;
  try {
    for await (const response of call.responses) {
      switch (response.response.oneofKind) {
        case "data":
          await controller.dispatch({
            data: response.response.data.data,
            offset: response.response.data.offset,
            sessionId: response.response.data.sessionId,
            ...response.response.data.timestamp === void 0 ? {} : { timestamp: response.response.data.timestamp },
            type: "data"
          });
          break;
        case "complete":
          terminal = true;
          await controller.dispatch({ type: "complete" });
          await onTerminal().catch(() => void 0);
          break;
        case "error":
          terminal = true;
          await controller.dispatch({
            error: new CWSandboxTransportError(
              response.response.error.message || "Log stream failed.",
              {
                operation: "Stream logs",
                sandboxId: request.sandboxId,
                transport: "grpc",
                transportCode: response.response.error.code
              }
            ),
            type: "error"
          });
          await onTerminal().catch(() => void 0);
          break;
        case void 0:
          break;
      }
    }
    await call.status;
    if (!terminal) {
      await controller.dispatch({ type: "complete" });
    }
  } catch (error) {
    await controller.dispatch({
      error: mapGrpcError(error, {
        operation: "Stream logs",
        sandboxId: request.sandboxId
      }),
      type: "error"
    });
  } finally {
    await onTerminal().catch(() => void 0);
  }
}

// src/node/grpc-transport.ts
var GrpcSandboxTransport = class {
  client;
  streamingClient;
  constructor(options) {
    const clients = createGrpcClients(options);
    this.client = clients.client;
    this.streamingClient = clients.streamingClient;
  }
  async start(request) {
    const response = await withGrpcErrorMapping(
      "Start sandbox",
      () => this.client.start(toProtoStartRequest(request), toRpcOptions(request)).response
    );
    return {
      sandboxId: response.sandboxId,
      status: toSdkSandboxStatus(response.sandboxStatus)
    };
  }
  async get(request) {
    const response = await withGrpcErrorMapping(
      "Get sandbox",
      () => this.client.get(
        {
          maxTimeoutSeconds: timeoutMsToSeconds(request.timeoutMs),
          sandboxId: request.sandboxId
        },
        toRpcOptions(request)
      ).response,
      request.sandboxId
    );
    return {
      sandboxId: response.sandboxId,
      status: toSdkSandboxStatus(response.sandboxStatus),
      ...response.serviceAddress ? { serviceAddress: response.serviceAddress } : {}
    };
  }
  async list(options) {
    const response = await withGrpcErrorMapping(
      "List sandboxes",
      () => this.client.list(toProtoListSandboxesRequest(options), toRpcOptions(options)).response
    );
    return toSdkListSandboxesResult(response);
  }
  async delete(request) {
    const response = await withGrpcErrorMapping(
      "Delete sandbox",
      () => this.client.delete(
        {
          maxTimeoutSeconds: timeoutMsToSeconds(request.timeoutMs),
          sandboxId: request.sandboxId
        },
        toRpcOptions(request)
      ).response,
      request.sandboxId
    );
    assertGrpcSuccess(response, {
      fallbackMessage: "Failed to delete sandbox.",
      operation: "Delete sandbox",
      sandboxId: request.sandboxId
    });
  }
  async exec(request) {
    const response = await withGrpcErrorMapping(
      "Exec command",
      () => this.client.exec(toProtoExecRequest(request), toRpcOptions(request)).response,
      request.sandboxId
    );
    return toSdkProcessResult(request.command, response.result ?? emptyExecResponse());
  }
  async startCommand(request) {
    return startGrpcCommand(this.streamingClient, request);
  }
  async streamLogs(request) {
    return startGrpcLogStream(this.streamingClient, request);
  }
  async stop(request) {
    const response = await withGrpcErrorMapping(
      "Stop sandbox",
      () => this.client.stop(
        {
          fileSystemSnapshotOnStop: request.snapshotOnStop ?? false,
          gracefulShutdownSeconds: request.gracefulShutdownSeconds ?? 0,
          idempotencyKey: "",
          maxTimeoutSeconds: timeoutMsToSeconds(request.timeoutMs),
          sandboxId: request.sandboxId
        },
        toRpcOptions(request)
      ).response,
      request.sandboxId
    );
    assertGrpcSuccess(response, {
      fallbackMessage: "Failed to stop sandbox.",
      operation: "Stop sandbox",
      sandboxId: request.sandboxId
    });
  }
  async writeFile(request) {
    const response = await withGrpcErrorMapping(
      "Write file",
      () => this.client.addFile(
        {
          fileContents: request.content,
          filepath: request.path,
          maxTimeoutSeconds: timeoutMsToSeconds(request.timeoutMs),
          sandboxId: request.sandboxId
        },
        toRpcOptions(request)
      ).response,
      request.sandboxId
    );
    assertGrpcSuccess(response, {
      fallbackMessage: "Failed to write file.",
      operation: "Write file",
      sandboxId: request.sandboxId
    });
  }
  async readFile(request) {
    const response = await withGrpcErrorMapping(
      "Read file",
      () => this.client.retrieveFile(
        {
          filepath: request.path,
          maxTimeoutSeconds: timeoutMsToSeconds(request.timeoutMs),
          sandboxId: request.sandboxId
        },
        toRpcOptions(request)
      ).response,
      request.sandboxId
    );
    assertGrpcSuccess(response, {
      fallbackMessage: "Failed to read file.",
      operation: "Read file",
      sandboxId: request.sandboxId
    });
    return {
      content: response.fileContents
    };
  }
};
function assertGrpcSuccess(response, options) {
  if (!response.success) {
    throw new CWSandboxTransportError(response.errorMessage || options.fallbackMessage, {
      operation: options.operation,
      sandboxId: options.sandboxId,
      transport: "grpc"
    });
  }
}
function emptyExecResponse() {
  return {
    exitCode: -1,
    stderr: new Uint8Array(),
    stderrBytesProduced: "0",
    stderrTruncated: false,
    stdout: new Uint8Array(),
    stdoutBytesProduced: "0",
    stdoutTruncated: false
  };
}

export {
  DEFAULT_CONTAINER_IMAGE,
  GrpcSandboxTransport
};
//# sourceMappingURL=chunk-W5QKV4YH.js.map