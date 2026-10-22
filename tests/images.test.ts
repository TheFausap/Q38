/**
 * Pictures in the prompt: a user turn with images goes out as OpenAI-style
 * parts (images first, then the words), everything else stays a plain string,
 * and the estimates count what a picture costs.
 *
 *   node --import ./tests/ts-resolve.mjs --experimental-strip-types tests/images.test.ts
 */
import assert from "node:assert/strict";
import { buildWireMessages, wireText } from "../src/lib/api.ts";
import { messageTokens } from "../src/lib/context.ts";
import { imageTokens, visionFromProps } from "../src/lib/images.ts";
import { DEFAULT_SETTINGS, type ChatMessage } from "../src/lib/types.ts";

const settings = { ...DEFAULT_SETTINGS, systemPrompt: "sys" };
const pic = { id: "inline-a", name: "a.png", mime: "image/png", width: 280, height: 140, bytes: 10, data: "data:image/png;base64,AAAA" };
const messages: ChatMessage[] = [
  { id: "1", role: "user", content: "what is this?", images: [pic] },
  { id: "2", role: "assistant", content: "a square" },
  { id: "3", role: "user", content: "and now?" },
];

const wire = buildWireMessages(messages, settings, {});
assert.equal(wire[0].role, "system");
assert.deepEqual(wire[1].content, [
  { type: "image_url", image_url: { url: pic.data } },
  { type: "text", text: "what is this?" },
]);
assert.equal(wire[2].content, "a square", "an assistant turn stays a string");
assert.equal(wire[3].content, "and now?", "a turn without pictures stays a string");
assert.equal(wireText(wire[1].content), "[image]\nwhat is this?");

/* a picture with no text is still a turn */
const bare = buildWireMessages([{ id: "1", role: "user", content: "", images: [pic] }], settings, {});
assert.deepEqual(bare[1].content, [{ type: "image_url", image_url: { url: pic.data } }]);

/* a stored picture whose bytes never came back is named, not dropped silently */
const lost = buildWireMessages(
  [{ id: "1", role: "user", content: "look", images: [{ ...pic, id: "f".repeat(64), data: undefined }] }],
  settings,
  {},
);
assert.deepEqual(lost[1].content, [{ type: "text", text: "look\n\n(attached image not available: a.png)" }]);

/* 280×140 is 10×5 patches of 28 px, plus the markers */
assert.equal(imageTokens(pic), 58);
assert.ok(messageTokens(messages[0]) > imageTokens(pic), "the estimate counts the picture");

assert.equal(visionFromProps({ modalities: { vision: true, audio: false } }), true);
assert.equal(visionFromProps({ modalities: { vision: false } }), false);
assert.equal(visionFromProps({}), null);
assert.equal(visionFromProps(null), null);

console.log("images ok");
