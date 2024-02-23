import { CameraNode } from 'cleo'
import { useState, useEffect } from 'react'
import Collapsable from '../../../components/Collapsable'
import './CameraEditor.css'

export default function CameraEditor(props: {node: CameraNode}) {
  const [type, setType] = useState<'perspective' | 'orthographic'>(props.node.camera.type)
  const [fov, setFov] = useState<number>(props.node.camera.fov)
  const [near, setNear] = useState<number>(props.node.camera.near)
  const [far, setFar] = useState<number>(props.node.camera.far)
  const [left, setLeft] = useState<number>(props.node.camera.left)
  const [right, setRight] = useState<number>(props.node.camera.right)
  const [bottom, setBottom] = useState<number>(props.node.camera.bottom)
  const [top, setTop] = useState<number>(props.node.camera.top)

  useEffect(() => {
    setType(props.node.camera.type)
    setFov(props.node.camera.fov)
    setNear(props.node.camera.near)
    setFar(props.node.camera.far)
    setLeft(props.node.camera.left)
    setRight(props.node.camera.right)
    setBottom(props.node.camera.bottom)
    setTop(props.node.camera.top)
  }, [props.node])

  useEffect(() => {
    props.node.camera.type = type
  }, [type])

  useEffect(() => {
    props.node.camera.fov = fov
  }, [fov])

  useEffect(() => {
    props.node.camera.near = near
  }, [near])

  useEffect(() => {
    props.node.camera.far = far
  }, [far])

  useEffect(() => {
    props.node.camera.left = left
  }, [left])

  useEffect(() => {
    props.node.camera.right = right
  }, [right])

  useEffect(() => {
    props.node.camera.bottom = bottom
  }, [bottom])

  useEffect(() => {
    props.node.camera.top = top
  }, [top])

  return (
    <Collapsable title='Camera'>
      <div className='camera-editor'>
        <div>
          <label>Type</label>
          <select value={type} onChange={e => setType(e.target.value as 'perspective' | 'orthographic')}>
            <option value='perspective'>Perspective</option>
            <option value='orthographic'>Orthographic</option>
          </select>
        </div>
        {type === 'perspective' && 
        <div>
          <label>Field of View</label>
          <input type='range' min='1' max='179' value={fov} onChange={e => setFov(parseFloat(e.target.value))} />
          {fov.toFixed(2)}
        </div>}
        <div>
          <label>Near</label>
          <input type='number' value={near} onChange={e => setNear(parseFloat(e.target.value))} />
        </div>
        <div>
          <label>Far</label>
          <input type='number' value={far} onChange={e => setFar(parseFloat(e.target.value))} />
        </div>
        {type === 'orthographic' && <>
          <div>
            <label>Left</label>
            <input type='number' value={left} onChange={e => setLeft(parseFloat(e.target.value))} />
          </div>
          <div>
            <label>Right</label>
            <input type='number' value={right} onChange={e => setRight(parseFloat(e.target.value))} />
          </div>
          <div>
            <label>Bottom</label>
            <input type='number' value={bottom} onChange={e => setBottom(parseFloat(e.target.value))} />
          </div>
          <div>
            <label>Top</label>
            <input type='number' value={top} onChange={e => setTop(parseFloat(e.target.value))} />
          </div>
        </> }
      </div>
    </Collapsable>
  )
}
