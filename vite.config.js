import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  base: '/quiz-battle/', // 👈 老師，請務必加上這一行，這是您的 Repository 名稱
})