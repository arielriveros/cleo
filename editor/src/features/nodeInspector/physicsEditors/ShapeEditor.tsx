import { ShapeDescription } from '../../EngineContext';
import AxisInput from '../../../components/AxisInput';

export default function ShapeEditor(props: {
  shape: ShapeDescription;
  setShape: (shape: any) => void;
  removeShape: () => void;
}) {

  const number = 'bg-[#3b3b3b] text-white border border-[#2d2d77] rounded px-2 py-1 w-[100px]';

  return (
    <div className='w-full p-2'>
        <table className='w-full border-collapse'>
          <tbody>
            {props.shape.type === 'box' && (
              <>
                <tr>
                  <td colSpan={2}>
                    <b>Box</b>
                  </td>
                </tr>
                <tr>
                  <td>
                    <label>Width</label>
                  </td>
                  <td>
                    <input
                      className={number}
                      type='number'
                      value={props.shape.width}
                      step={0.01}
                      onChange={(e) =>
                        props.setShape({
                          ...props.shape,
                          width: parseFloat(e.target.value),
                        })
                      }
                    />
                  </td>
                </tr>
                <tr>
                  <td>
                    <label>Height</label>
                  </td>
                  <td>
                    <input
                      className={number}
                      type='number'
                      value={props.shape.height}
                      step={0.01}
                      onChange={(e) =>
                        props.setShape({
                          ...props.shape,
                          height: parseFloat(e.target.value),
                        })
                      }
                    />
                  </td>
                </tr>
                <tr>
                  <td>
                    <label>Depth</label>
                  </td>
                  <td>
                    <input
                      className={number}
                      type='number'
                      value={props.shape.depth}
                      step={0.01}
                      onChange={(e) =>
                        props.setShape({
                          ...props.shape,
                          depth: parseFloat(e.target.value),
                        })
                      }
                    />
                  </td>
                </tr>
              </>
            )}

            {props.shape.type === 'sphere' && (
              <>
                <tr>
                  <td colSpan={2}>
                    <b>Sphere</b>
                  </td>
                </tr>
                <tr>
                  <td>
                    <label>Radius</label>
                  </td>
                  <td>
                    <input
                      className={number}
                      type='number'
                      value={props.shape.radius}
                      step={0.01}
                      onChange={(e) =>
                        props.setShape({
                          ...props.shape,
                          radius: parseFloat(e.target.value),
                        })
                      }
                    />
                  </td>
                </tr>
              </>
            )}

            {props.shape.type === 'cylinder' && (
              <>
                <tr>
                  <td colSpan={2}>
                    <b>Cylinder</b>
                  </td>
                </tr>
                <tr>
                  <td>
                    <label>Radius</label>
                  </td>
                  <td>
                    <input
                      className={number}
                      type='number'
                      value={props.shape.radius}
                      step={0.01}
                      onChange={(e) =>
                        props.setShape({
                          ...props.shape,
                          radius: parseFloat(e.target.value),
                        })
                      }
                    />
                  </td>
                </tr>
                <tr>
                  <td>
                    <label>Height</label>
                  </td>
                  <td>
                    <input
                      className={number}
                      type='number'
                      value={props.shape.height}
                      step={0.01}
                      onChange={(e) =>
                        props.setShape({
                          ...props.shape,
                          height: parseFloat(e.target.value),
                        })
                      }
                    />
                  </td>
                </tr>
                <tr>
                  <td>
                    <label>Segments</label>
                  </td>
                  <td>
                    <input
                      className={number}
                      type='number'
                      value={props.shape.numSegments}
                      step={1}
                      onChange={(e) =>
                        props.setShape({
                          ...props.shape,
                          numSegments: parseInt(e.target.value),
                        })
                      }
                    />
                  </td>
                </tr>
              </>
            )}

            {props.shape.type === 'plane' && (
              <tr>
                <td colSpan={2}>
                  <b>Plane</b>
                </td>
              </tr>
            )}

            <tr>
              <td>
                <label>Offset</label>
              </td>
              <td>
                <AxisInput value={[ props.shape.offset[0], props.shape.offset[1], props.shape.offset[2] ]} step={0.01} onChange={(value) => props.setShape({ ...props.shape, offset: [value[0], value[1], value[2]]})
                  }
                />
              </td>
            </tr>

            <tr>
              <td>
                <label>Rotation</label>
              </td>
              <td>
                <AxisInput value={[props.shape.rotation[0], props.shape.rotation[1], props.shape.rotation[2]]} step={0.1} min={-180} max={180} onChange={(value) => props.setShape({ ...props.shape, rotation: [ value[0], value[1], value[2] ] }) } />
              </td>
            </tr>
          </tbody>
        </table>

        <button className='mt-2 px-3 py-1 bg-[#3b3b3b] border border-[#2d2d77] rounded hover:bg-[#3f3fb4]' onClick={() => props.removeShape()}>Remove</button>
    </div>
  );
}
