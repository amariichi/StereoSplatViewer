type PlyElementProperty = {
  name: string;
  type: string;
  isList: boolean;
  countType?: string;
};

type PlyElement = {
  name: string;
  count: number;
  properties: PlyElementProperty[];
};

type PlyHeader = {
  format: "ascii" | "binary_little_endian" | "binary_big_endian";
  elements: PlyElement[];
};

type PlyCameraMeta = {
  width: number;
  height: number;
  fx: number;
  fy: number;
};

const TYPE_SIZE: Record<string, number> = {
  char: 1,
  int8: 1,
  uchar: 1,
  uint8: 1,
  short: 2,
  int16: 2,
  ushort: 2,
  uint16: 2,
  int: 4,
  int32: 4,
  uint: 4,
  uint32: 4,
  float: 4,
  float32: 4,
  double: 8,
  float64: 8,
};

const findHeaderEnd = (bytes: Uint8Array) => {
  const token = [101, 110, 100, 95, 104, 101, 97, 100, 101, 114]; // "end_header"
  for (let i = 0; i < bytes.length - token.length; i += 1) {
    let match = true;
    for (let j = 0; j < token.length; j += 1) {
      if (bytes[i + j] !== token[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      for (let k = i + token.length; k < bytes.length; k += 1) {
        if (bytes[k] === 10) {
          return k + 1;
        }
      }
    }
  }
  return -1;
};

const parseHeader = (text: string): PlyHeader | null => {
  const lines = text.split(/\r?\n/);
  let format: PlyHeader["format"] | null = null;
  const elements: PlyElement[] = [];
  let current: PlyElement | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("comment")) continue;
    const parts = trimmed.split(/\s+/);
    if (parts[0] === "format" && parts.length >= 2) {
      if (
        parts[1] === "ascii" ||
        parts[1] === "binary_little_endian" ||
        parts[1] === "binary_big_endian"
      ) {
        format = parts[1];
      }
      continue;
    }
    if (parts[0] === "element" && parts.length >= 3) {
      current = {
        name: parts[1],
        count: Number(parts[2]),
        properties: [],
      };
      elements.push(current);
      continue;
    }
    if (parts[0] === "property" && current) {
      if (parts[1] === "list" && parts.length >= 5) {
        current.properties.push({
          name: parts[4],
          type: parts[3],
          isList: true,
          countType: parts[2],
        });
      } else if (parts.length >= 3) {
        current.properties.push({
          name: parts[2],
          type: parts[1],
          isList: false,
        });
      }
    }
  }

  if (!format) return null;
  return { format, elements };
};

const readScalar = (view: DataView, offset: number, type: string) => {
  switch (type) {
    case "char":
    case "int8":
      return { value: view.getInt8(offset), next: offset + 1 };
    case "uchar":
    case "uint8":
      return { value: view.getUint8(offset), next: offset + 1 };
    case "short":
    case "int16":
      return { value: view.getInt16(offset, true), next: offset + 2 };
    case "ushort":
    case "uint16":
      return { value: view.getUint16(offset, true), next: offset + 2 };
    case "int":
    case "int32":
      return { value: view.getInt32(offset, true), next: offset + 4 };
    case "uint":
    case "uint32":
      return { value: view.getUint32(offset, true), next: offset + 4 };
    case "double":
    case "float64":
      return { value: view.getFloat64(offset, true), next: offset + 8 };
    case "float":
    case "float32":
    default:
      return { value: view.getFloat32(offset, true), next: offset + 4 };
  }
};

const parseBinaryMeta = (buffer: ArrayBuffer, header: PlyHeader, dataStart: number) => {
  if (header.format !== "binary_little_endian") {
    return null;
  }
  const view = new DataView(buffer);
  let offset = dataStart;
  let intrinsic: number[] | null = null;
  let imageSize: number[] | null = null;

  for (const element of header.elements) {
    const stride = element.properties.reduce((sum, prop) => {
      if (prop.isList) {
        return sum;
      }
      return sum + (TYPE_SIZE[prop.type] ?? 0);
    }, 0);

    if (element.properties.some((prop) => prop.isList)) {
      return null;
    }

    if (element.name === "intrinsic") {
      intrinsic = [];
      for (let i = 0; i < element.count; i += 1) {
        for (const prop of element.properties) {
          const result = readScalar(view, offset, prop.type);
          offset = result.next;
          intrinsic.push(Number(result.value));
        }
      }
      continue;
    }

    if (element.name === "image_size") {
      imageSize = [];
      for (let i = 0; i < element.count; i += 1) {
        for (const prop of element.properties) {
          const result = readScalar(view, offset, prop.type);
          offset = result.next;
          imageSize.push(Number(result.value));
        }
      }
      continue;
    }

    offset += stride * element.count;
  }

  if (!intrinsic || intrinsic.length < 9 || !imageSize || imageSize.length < 2) {
    return null;
  }

  const fx = intrinsic[0];
  const fy = intrinsic[4];
  const width = imageSize[0];
  const height = imageSize[1];
  if (![fx, fy, width, height].every(Number.isFinite)) {
    return null;
  }
  return { fx, fy, width, height };
};

const computeFovDeg = (meta: PlyCameraMeta) => {
  const useHorizontal = meta.width >= meta.height;
  const fovX = (2 * Math.atan((meta.width / 2) / meta.fx) * 180) / Math.PI;
  const fovY = (2 * Math.atan((meta.height / 2) / meta.fy) * 180) / Math.PI;
  return useHorizontal ? fovX : fovY;
};

export const fetchPlyCameraFov = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) {
    return null;
  }
  const buffer = await res.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const headerEnd = findHeaderEnd(bytes);
  if (headerEnd < 0) {
    return null;
  }
  const headerText = new TextDecoder("ascii").decode(bytes.slice(0, headerEnd));
  const header = parseHeader(headerText);
  if (!header) {
    return null;
  }
  const meta = parseBinaryMeta(buffer, header, headerEnd);
  if (!meta) {
    return null;
  }
  const fov = computeFovDeg(meta);
  if (!Number.isFinite(fov)) {
    return null;
  }
  return fov;
};
