import { useState } from 'react'
import { render } from '@gpuix/react'

function Hello() {
  const [count, setCount] = useState(0)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: 24, backgroundColor: '#1A1A1A', width: '100%', height: '100%' }}>
      <text style={{ color: '#E2E2E2', fontSize: 26 }}>spike-gpuix</text>
      <div onClick={() => setCount(count + 1)} style={{ padding: 8, backgroundColor: '#333' }}>
        <text style={{ color: '#E2E2E2' }}>Clicked {count}</text>
      </div>
    </div>
  )
}

render(<Hello />, { title: 'spike-gpuix', width: 480, height: 360 })
