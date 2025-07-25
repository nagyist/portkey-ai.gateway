import {
  AZURE_OPEN_AI,
  BEDROCK,
  CONTENT_TYPES,
  COHERE,
  GOOGLE,
  REQUEST_TIMEOUT_STATUS_CODE,
  PRECONDITION_CHECK_FAILED_STATUS_CODE,
  GOOGLE_VERTEX_AI,
} from '../globals';
import { VertexLlamaChatCompleteStreamChunkTransform } from '../providers/google-vertex-ai/chatComplete';
import { OpenAIChatCompleteResponse } from '../providers/openai/chatComplete';
import { OpenAICompleteResponse } from '../providers/openai/complete';
import { Params } from '../types/requestBody';
import { getStreamModeSplitPattern, type SplitPatternType } from '../utils';

function readUInt32BE(buffer: Uint8Array, offset: number) {
  return (
    ((buffer[offset] << 24) |
      (buffer[offset + 1] << 16) |
      (buffer[offset + 2] << 8) |
      buffer[offset + 3]) >>>
    0
  ); // Ensure the result is an unsigned integer
}

function getPayloadFromAWSChunk(chunk: Uint8Array): string {
  const decoder = new TextDecoder();
  const chunkLength = readUInt32BE(chunk, 0);
  const headersLength = readUInt32BE(chunk, 4);

  // prelude 8 + Prelude crc 4 = 12
  const headersEnd = 12 + headersLength;

  const payloadLength = chunkLength - headersEnd - 4; // Subtracting 4 for the message crc
  const payload = chunk.slice(headersEnd, headersEnd + payloadLength);
  const decodedJson = JSON.parse(decoder.decode(payload));
  return decodedJson.bytes
    ? Buffer.from(decodedJson.bytes, 'base64').toString()
    : JSON.stringify(decodedJson);
}

function concatenateUint8Arrays(a: Uint8Array, b: Uint8Array): Uint8Array {
  const result = new Uint8Array(a.length + b.length);
  result.set(a, 0); // Copy contents of array 'a' into 'result' starting at index 0
  result.set(b, a.length); // Copy contents of array 'b' into 'result' starting at index 'a.length'
  return result;
}

export async function* readAWSStream(
  reader: ReadableStreamDefaultReader,
  transformFunction: Function | undefined,
  fallbackChunkId: string,
  strictOpenAiCompliance: boolean,
  gatewayRequest: Params
) {
  let buffer = new Uint8Array();
  let expectedLength = 0;
  const streamState = {};
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      if (buffer.length) {
        expectedLength = readUInt32BE(buffer, 0);
        while (buffer.length >= expectedLength && buffer.length !== 0) {
          const data = buffer.subarray(0, expectedLength);
          buffer = buffer.subarray(expectedLength);
          expectedLength = readUInt32BE(buffer, 0);
          const payload = getPayloadFromAWSChunk(data);
          if (transformFunction) {
            const transformedChunk = transformFunction(
              payload,
              fallbackChunkId,
              streamState,
              strictOpenAiCompliance,
              gatewayRequest
            );
            if (Array.isArray(transformedChunk)) {
              for (const item of transformedChunk) {
                yield item;
              }
            } else {
              yield transformedChunk;
            }
          } else {
            yield data;
          }
        }
      }
      break;
    }

    if (expectedLength === 0) {
      expectedLength = readUInt32BE(value, 0);
    }

    buffer = concatenateUint8Arrays(buffer, value);

    while (buffer.length >= expectedLength && buffer.length !== 0) {
      const data = buffer.subarray(0, expectedLength);
      buffer = buffer.subarray(expectedLength);

      expectedLength = readUInt32BE(buffer, 0);
      const payload = getPayloadFromAWSChunk(data);

      if (transformFunction) {
        const transformedChunk = transformFunction(
          payload,
          fallbackChunkId,
          streamState,
          strictOpenAiCompliance,
          gatewayRequest
        );
        if (Array.isArray(transformedChunk)) {
          for (const item of transformedChunk) {
            yield item;
          }
        } else {
          yield transformedChunk;
        }
      } else {
        yield data;
      }
    }
  }
}

export async function* readStream(
  reader: ReadableStreamDefaultReader,
  splitPattern: SplitPatternType,
  transformFunction: Function | undefined,
  isSleepTimeRequired: boolean,
  fallbackChunkId: string,
  strictOpenAiCompliance: boolean,
  gatewayRequest: Params
) {
  let buffer = '';
  const decoder = new TextDecoder();
  let isFirstChunk = true;
  const streamState = {};

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      if (buffer.length > 0) {
        if (transformFunction) {
          yield transformFunction(
            buffer,
            fallbackChunkId,
            streamState,
            strictOpenAiCompliance,
            gatewayRequest
          );
        } else {
          yield buffer;
        }
      }
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    // keep buffering until we have a complete chunk

    while (buffer.split(splitPattern).length > 1) {
      const parts = buffer.split(splitPattern);
      const lastPart = parts.pop() ?? ''; // remove the last part from the array and keep it in buffer
      for (const part of parts) {
        // Some providers send ping event which can be ignored during parsing

        if (part.length > 0) {
          if (isFirstChunk) {
            isFirstChunk = false;
            await new Promise((resolve) => setTimeout(resolve, 25));
          } else if (isSleepTimeRequired) {
            await new Promise((resolve) => setTimeout(resolve, 1));
          }

          if (transformFunction) {
            const transformedChunk = transformFunction(
              part,
              fallbackChunkId,
              streamState,
              strictOpenAiCompliance,
              gatewayRequest
            );
            if (transformedChunk !== undefined) {
              yield transformedChunk;
            }
          } else {
            yield part + splitPattern;
          }
        }
      }

      buffer = lastPart; // keep the last part (after the last '\n\n') in buffer
    }
  }
}

export async function handleTextResponse(
  response: Response,
  responseTransformer: Function | undefined
) {
  const text = await response.text();

  if (responseTransformer) {
    const transformedText = responseTransformer(
      { 'html-message': text },
      response.status
    );
    return new Response(JSON.stringify(transformedText), {
      ...response,
      status: response.status,
      headers: new Headers({
        ...Object.fromEntries(response.headers),
        'content-type': 'application/json',
      }),
    });
  }

  return new Response(text, response);
}

export async function handleNonStreamingMode(
  response: Response,
  responseTransformer: Function | undefined,
  strictOpenAiCompliance: boolean,
  gatewayRequestUrl: string,
  gatewayRequest: Params,
  areSyncHooksAvailable: boolean
): Promise<{
  response: Response;
  json: Record<string, any> | null;
  originalResponseBodyJson?: Record<string, any> | null;
}> {
  // 408 is thrown whenever a request takes more than request_timeout to respond.
  // In that case, response thrown by gateway is already in OpenAI format.
  // So no need to transform it again.
  if (
    [
      REQUEST_TIMEOUT_STATUS_CODE,
      PRECONDITION_CHECK_FAILED_STATUS_CODE,
    ].includes(response.status)
  ) {
    return { response, json: await response.clone().json() };
  }

  const isJsonParsingRequired = responseTransformer || areSyncHooksAvailable;
  const originalResponseBodyJson: Record<string, any> | null =
    isJsonParsingRequired ? await response.json() : null;
  let responseBodyJson = originalResponseBodyJson;
  if (responseTransformer) {
    responseBodyJson = responseTransformer(
      responseBodyJson,
      response.status,
      response.headers,
      strictOpenAiCompliance,
      gatewayRequestUrl,
      gatewayRequest
    );
  } else if (!areSyncHooksAvailable) {
    return {
      response: new Response(response.body, response),
      json: null,
      originalResponseBodyJson,
    };
  }

  return {
    response: new Response(JSON.stringify(responseBodyJson), response),
    json: responseBodyJson as Record<string, any>,
    // Send original response if transformer exists
    ...(responseTransformer && { originalResponseBodyJson }),
  };
}

export function handleAudioResponse(response: Response) {
  return new Response(response.body, response);
}

export function handleOctetStreamResponse(response: Response) {
  return new Response(response.body, response);
}

export function handleImageResponse(response: Response) {
  return new Response(response.body, response);
}

export function handleStreamingMode(
  response: Response,
  proxyProvider: string,
  responseTransformer: Function | undefined,
  requestURL: string,
  strictOpenAiCompliance: boolean,
  gatewayRequest: Params
): Response {
  const splitPattern = getStreamModeSplitPattern(proxyProvider, requestURL);
  // If the provider doesn't supply completion id,
  // we generate a fallback id using the provider name + timestamp.
  const fallbackChunkId = `${proxyProvider}-${Date.now().toString()}`;

  if (!response.body) {
    throw new Error('Response format is invalid. Body not found');
  }
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const reader = response.body.getReader();
  const isSleepTimeRequired = proxyProvider === AZURE_OPEN_AI ? true : false;
  const encoder = new TextEncoder();

  if (proxyProvider === BEDROCK) {
    (async () => {
      try {
        for await (const chunk of readAWSStream(
          reader,
          responseTransformer,
          fallbackChunkId,
          strictOpenAiCompliance,
          gatewayRequest
        )) {
          await writer.write(encoder.encode(chunk));
        }
      } catch (error) {
        console.error(error);
      } finally {
        writer.close();
      }
    })();
  } else {
    (async () => {
      try {
        for await (const chunk of readStream(
          reader,
          splitPattern,
          responseTransformer,
          isSleepTimeRequired,
          fallbackChunkId,
          strictOpenAiCompliance,
          gatewayRequest
        )) {
          await writer.write(encoder.encode(chunk));
        }
      } catch (error) {
        console.error(error);
      } finally {
        writer.close();
      }
    })();
  }

  // Convert GEMINI/COHERE json stream to text/event-stream for non-proxy calls
  const isGoogleCohereOrBedrock = [GOOGLE, COHERE, BEDROCK].includes(
    proxyProvider
  );
  const isVertexLlama =
    proxyProvider === GOOGLE_VERTEX_AI &&
    responseTransformer?.name ===
      VertexLlamaChatCompleteStreamChunkTransform.name;
  const isJsonStream = isGoogleCohereOrBedrock || isVertexLlama;
  if (isJsonStream && responseTransformer) {
    return new Response(readable, {
      ...response,
      headers: new Headers({
        ...Object.fromEntries(response.headers),
        'content-type': 'text/event-stream',
      }),
    });
  }

  return new Response(readable, response);
}

export async function handleJSONToStreamResponse(
  response: Response,
  provider: string,
  responseTransformerFunction: Function
): Promise<Response> {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const responseJSON: OpenAIChatCompleteResponse | OpenAICompleteResponse =
    await response.clone().json();

  if (
    Object.prototype.toString.call(responseTransformerFunction) ===
    '[object GeneratorFunction]'
  ) {
    const generator = responseTransformerFunction(responseJSON, provider);
    (async () => {
      while (true) {
        const chunk = generator.next();
        if (chunk.done) {
          break;
        }
        await writer.write(encoder.encode(chunk.value));
      }
      writer.close();
    })();
  } else {
    const streamChunkArray = responseTransformerFunction(
      responseJSON,
      provider
    );
    (async () => {
      for (const chunk of streamChunkArray) {
        await writer.write(encoder.encode(chunk));
      }
      writer.close();
    })();
  }

  return new Response(readable, {
    headers: new Headers({
      ...Object.fromEntries(response.headers),
      'content-type': CONTENT_TYPES.EVENT_STREAM,
    }),
    status: response.status,
    statusText: response.statusText,
  });
}
