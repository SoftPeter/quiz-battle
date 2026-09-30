# 퀴즈 뽑기 배틀

## 배포
1. 이 폴더를 GitHub 새 repo에 push
2. Vercel → Add New → Project → 해당 repo Import → Deploy
3. Vercel 프로젝트 → Storage → Create Database → Upstash for Redis → 프로젝트에 Connect
   (환경변수 KV_REST_API_URL / KV_REST_API_TOKEN 자동 등록)
4. Deployments → 최신 배포 Redeploy (환경변수 반영)
5. 배포 링크 접속 → 새 방 만들기 → 링크 공유

## 로컬 실행
npm i -g vercel && vercel link && vercel env pull && vercel dev
