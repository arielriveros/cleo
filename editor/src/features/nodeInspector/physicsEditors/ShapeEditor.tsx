import { ShapeDescription } from '../../EngineContext'
import './Styles.css'

export default function ShapeEditor(props: {shape: ShapeDescription, setShape: (shape: any) => void, removeShape: () => void}) {
  return (
    <div className='shape-editor'>
      { props.shape.type === 'box' && 
        <>
          <b>Box</b>
          <div className='shape-editor-row'>
            <label>Width</label>
            <input type='number' value={(props.shape).width} onChange={(e) => props.setShape({...props.shape, width: parseFloat(e.target.value)})} />
          </div>
          <div className='shape-editor-row'>
            <label>Height</label>
            <input type='number' value={(props.shape).height} onChange={(e) => props.setShape({...props.shape, height: parseFloat(e.target.value)})} />
          </div>
          <div className='shape-editor-row'>
            <label>Depth</label>
            <input type='number' value={(props.shape).depth} onChange={(e) => props.setShape({...props.shape, depth: parseFloat(e.target.value)})} />
          </div>
        </>
      }

      { props.shape.type === 'sphere' && 
        <>
          <b>Sphere</b>
          <div className='shape-editor-row'>
            <label>Radius</label>
            <input type='number' value={(props.shape).radius} onChange={(e) => props.setShape({...props.shape, radius: parseFloat(e.target.value)})} />
          </div>
        </>
      }

      { props.shape.type === 'plane' && <b>Plane</b> }

      <div className='shape-editor-row'>
        <label>Offset</label>
        <div className='shape-editor-row-input'>
          <input className='number-input' type='number' value={(props.shape).offset[0]} onChange={(e) => props.setShape({...props.shape, offset: [parseFloat(e.target.value), props.shape.offset[1], props.shape.offset[2]]})} />
          <input className='number-input' type='number' value={(props.shape).offset[1]} onChange={(e) => props.setShape({...props.shape, offset: [props.shape.offset[0], parseFloat(e.target.value), props.shape.offset[2]]})} />
          <input className='number-input' type='number' value={(props.shape).offset[2]} onChange={(e) => props.setShape({...props.shape, offset: [props.shape.offset[0], props.shape.offset[1], parseFloat(e.target.value)]})} />
        </div>
      </div>

      <div className='shape-editor-row'>
        <label>Rotation</label>
        <div className='shape-editor-row-input'>
          <input className='number-input' type='number' value={(props.shape).rotation[0]} onChange={(e) => props.setShape({...props.shape, rotation: [parseFloat(e.target.value), props.shape.rotation[1], props.shape.rotation[2]]})} />
          <input className='number-input' type='number' value={(props.shape).rotation[1]} onChange={(e) => props.setShape({...props.shape, rotation: [props.shape.rotation[0], parseFloat(e.target.value), props.shape.rotation[2]]})} />
          <input className='number-input' type='number' value={(props.shape).rotation[2]} onChange={(e) => props.setShape({...props.shape, rotation: [props.shape.rotation[0], props.shape.rotation[1], parseFloat(e.target.value)]})} />
        </div>
      </div>

      <button onClick={() => props.removeShape()}>Remove</button>
    </div>
  )

}
