import { ShapeDescription } from '../../EngineContext';
import AxisInput from '../../../components/AxisInput';
import './Styles.css';

export default function ShapeEditor(props: {
  shape: ShapeDescription;
  setShape: (shape: any) => void;
  removeShape: () => void;
}) {

  return (
    <div className='transform-container'>
        <table className='shape-editor-table'>
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
                      type='number'
                      value={props.shape.width}
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
                      type='number'
                      value={props.shape.height}
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
                      type='number'
                      value={props.shape.depth}
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
                      type='number'
                      value={props.shape.radius}
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

        <button onClick={() => props.removeShape()}>Remove</button>
    </div>
  );
}
