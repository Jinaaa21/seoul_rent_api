// Worker 진입점: /api/rent 는 서울시 API 프록시, 나머지는 public/ 정적 파일.
// 정적 파일이 먼저 응답하고, 해당 파일이 없을 때만 이 코드가 실행된다 (wrangler.jsonc 의 assets 설정).
import { handleRent, json } from "./rent.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/rent") {
      if (request.method !== "GET") {
        return json({ error: "GET 요청만 받습니다." }, 405, { Allow: "GET" });
      }
      return handleRent(request, env, ctx);
    }
    return env.ASSETS.fetch(request);
  },
};
